import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import type { ClawAutomationMutationRequest } from "../claws/automation-mutation-contract.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import { readPortableHeartbeatState } from "../claws/portable-heartbeat-state.js";
import { portableHeartbeatStateDigest } from "../claws/portable-heartbeat-state.kernel.js";
import { portableHeartbeatSettingsRevision } from "../claws/portable-heartbeat.js";
import { readClawInstallRecord } from "../claws/provenance.js";
import { getRuntimeConfig } from "../config/config.js";
import { issueOperatorToken, openTrackedWs } from "./device-authz.test-helpers.js";
import { useClawMonitorFixture } from "./server-claws-monitors.test-support.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const fixture = useClawMonitorFixture();

describe("Claw automation authenticated mutation", () => {
  it("requires an admin grant before changing a job, scratch, or Claw provenance", async () => {
    const current = await fixture(false, undefined, false, true);
    testState.agentsConfig = current.getConfig().agents;
    testState.cronStorePath = current.state.statePath("cron", "jobs.json");
    const started = await startServerWithClient("claw-auth-fixture");
    let adminWs: Awaited<ReturnType<typeof openTrackedWs>> | undefined;
    try {
      const writer = await issueOperatorToken({
        name: "claw-automation-writer",
        approvedScopes: ["operator.write"],
      });
      const admin = await issueOperatorToken({
        name: "claw-automation-admin",
        approvedScopes: ["operator.admin"],
      });
      adminWs = await openTrackedWs(started.port);
      const writerHello = await connectReq(started.ws, {
        skipDefaultAuth: true,
        deviceToken: writer.token,
        deviceIdentityPath: writer.identityPath,
        scopes: ["operator.write"],
      });
      expect(writerHello.ok, JSON.stringify(writerHello.error)).toBe(true);
      expect(writerHello.payload).toMatchObject({ auth: { scopes: ["operator.write"] } });
      const adminHello = await connectReq(adminWs, {
        skipDefaultAuth: true,
        deviceToken: admin.token,
        deviceIdentityPath: admin.identityPath,
        scopes: ["operator.admin"],
      });
      expect(adminHello.ok, JSON.stringify(adminHello.error)).toBe(true);
      expect(adminHello.payload).toMatchObject({ auth: { scopes: ["operator.admin"] } });

      const config = getRuntimeConfig();
      const before = await readPortableHeartbeatState("worker", config, {});
      const installBefore = expectDefined(readClawInstallRecord("worker"), "Claw install");
      expectDefined(before.job, "installed automation");
      expectDefined(before.ref, "Claw automation provenance");
      expectDefined(before.scratch.scratch, "installed scratch");
      const source = {
        heartbeat: { every: "45m", isolatedSession: true },
        scratch: "Updated checklist\n",
      };
      const request: ClawAutomationMutationRequest = {
        agentId: "worker",
        binding: resolveClawMonitorCleanupBinding(testState.cronStorePath),
        expectedStateDigest: portableHeartbeatStateDigest(before),
        mutation: {
          kind: "update",
          source,
          expectedSettingsRevision: portableHeartbeatSettingsRevision(
            config,
            "worker",
            source.heartbeat,
          ),
        },
      };
      const denied = await rpcReq(started.ws, "claws.automations.mutate", request);
      expect(denied).toMatchObject({
        ok: false,
        error: { message: "missing scope: operator.admin" },
      });
      expect(await readPortableHeartbeatState("worker", config, {})).toEqual(before);
      expect(readClawInstallRecord("worker")).toEqual(installBefore);

      const accepted = await rpcReq(adminWs, "claws.automations.mutate", request);
      expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
      const after = await readPortableHeartbeatState("worker", config, {});
      expect(after.job).toMatchObject({
        id: before.job?.id,
        schedule: { kind: "every", everyMs: 2_700_000 },
      });
      expect(after.scratch.scratch?.content).toBe(source.scratch);
      expect(after.scratch.currentRevision).toBeGreaterThan(before.scratch.currentRevision);
      expect(after.ref?.job.configRevision).not.toBe(before.ref?.job.configRevision);
      expect(after.ref?.job.scratchDigest).not.toBe(before.ref?.job.scratchDigest);
      expect(accepted.payload).toMatchObject({ stateDigest: portableHeartbeatStateDigest(after) });
    } finally {
      adminWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
