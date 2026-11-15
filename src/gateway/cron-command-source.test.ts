import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CronService } from "../cron/service.js";
import { ensureCanonicalGatewayOwnerProfile } from "../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runCronCommandUnderSource } from "./cron-command-source.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { recoveryFixture } from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const device: OpenClawIdTunnelPrincipal = {
  kind: "owner",
  peerKey: `iroh:${"de".repeat(32)}`,
  authority: { clawId: "command-claw", rootPub: "command-root", listedSeq: 1 },
};
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Real durable cron owner and real OS commands; only the original device's listing changes. */
it("runs a stored command only while its original OCID device stays admitted", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const peers = new Map([[device.peerKey, device]]);
    const publish = () => setOpenClawIdTunnelPrincipalLookup((key) => peers.get(key));
    publish();
    const context = createContext();
    const profile = await ensureCanonicalGatewayOwnerProfile("Synthetic owner");
    const { snapshot } = await recoveryFixture(stateDir, profile.id, {
      context,
      openclawIdPrincipal: device,
    });
    const cron = new CronService({
      storePath: path.join(stateDir, "cron", "jobs.json"),
      scheduler: createTestGatewayScheduler(),
      cronEnabled: true,
      defaultAgentId: "main",
      log: silent,
      enqueueSystemEvent: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
      runCommandJob: (params) => runCronCommandUnderSource(params, () => context),
    });
    context.cron = cron;
    context.resolveGatewayContext = () => context;
    const ran = path.join(stateDir, "command-ran");
    const started = path.join(stateDir, "command-started");
    const add = (source: string) =>
      cron.add(
        {
          name: "device command",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "command", argv: [process.execPath, "-e", source], timeoutSeconds: 60 },
        },
        {
          operatorSource: {
            version: 1,
            kind: "gateway",
            agentId: "main",
            sourceRunId: "turn",
            snapshot,
          },
        },
      );
    try {
      const once = await add(`require("node:fs").appendFileSync(${JSON.stringify(ran)}, "x")`);
      await cron.run(once.id, "force");
      expect(fs.readFileSync(ran, "utf8")).toBe("x");
      expect(cron.getJob(once.id)?.state.lastRunStatus).toBe("ok");

      const held = await add(
        `require("node:fs").writeFileSync(${JSON.stringify(started)}, "");setInterval(()=>{},1000)`,
      );
      const running = cron.run(held.id, "force");
      await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 15_000 });
      const before = Date.now();
      peers.delete(device.peerKey);
      publish();
      await running;
      // Revocation ended the process tree instead of letting it run to its 60s limit.
      expect(Date.now() - before).toBeLessThan(20_000);
      expect(cron.getJob(held.id)?.state.lastRunStatus).not.toBe("ok");

      await cron.run(once.id, "force");
      expect(fs.readFileSync(ran, "utf8")).toBe("x");
      expect(cron.getJob(once.id)?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: expect.stringContaining("operator authority"),
      });
    } finally {
      cron.stop();
      setOpenClawIdTunnelPrincipalLookup(undefined);
    }
  });
});
