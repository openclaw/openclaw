import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { readAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { captureScheduledOperatorSource } from "../../agents/operator-run-recovery-source.js";
import { ToolSearchRuntime } from "../../agents/tool-search-runtime.js";
import { resolveToolSearchConfig } from "../../agents/tool-search.js";
import { jsonResult } from "../../agents/tools/common.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { admitScheduledOccurrence } from "../../cron/execution-context-admission.js";
import { readScheduledSenderBit } from "../../cron/execution-context-registry.js";
import { CronService } from "../../cron/service.js";
import { resolveCronOperatorExecutionRevision } from "../../cron/service/jobs-tool-policy.js";
import { createCronScriptRuntime } from "../../cron/trigger-script.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureCanonicalGatewayOwnerProfile } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { retainCronControlSource } from "../cron-operator-source.js";
import { restoreGatewayOperatorSource } from "../operator-run-recovery.js";
import { recoveryFixture } from "../operator-run-recovery.test-support.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import { cronHandlers } from "../server-methods/cron.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

it.each([
  { kind: "member", target: "isolated", reset: false, direct: false },
  { kind: "owner", target: "isolated", reset: false, direct: false },
  { kind: "member", target: "main", reset: false, direct: false },
  { kind: "owner", target: "main", reset: false, direct: false },
  { kind: "member", target: "isolated", reset: true, direct: false },
  { kind: "member", target: "isolated", reset: false, direct: true },
  { kind: "member", target: "isolated", reset: false, direct: true, directAdmin: true },
  {
    kind: "member",
    target: "isolated",
    reset: false,
    direct: true,
    directAdmin: true,
    originalRevoked: true,
  },
] as const)(
  "keeps OCID $kind condition authority (target=$target reset=$reset directEdit=$direct directAdmin=$directAdmin originalRevoked=$originalRevoked)",
  async (scenario) => {
    const { kind, target, reset, direct } = scenario;
    const directAdmin = "directAdmin" in scenario && scenario.directAdmin;
    const originalRevoked = "originalRevoked" in scenario && scenario.originalRevoked;
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const profile =
        kind === "owner"
          ? await ensureCanonicalGatewayOwnerProfile("Synthetic owner")
          : ensureProfileForEmail("condition-member@example.test");
      let principal: OpenClawIdTunnelPrincipal | undefined = {
        ...(kind === "member"
          ? { kind, accountId: "condition-member", role: "operator" as const }
          : { kind }),
        peerKey: `iroh:${"da".repeat(32)}`,
        authority: { clawId: "condition-claw", rootPub: "condition-root", listedSeq: 1 },
      };
      const administrativeProfile = directAdmin
        ? await ensureCanonicalGatewayOwnerProfile("Synthetic owner")
        : undefined;
      const administrativePeer: OpenClawIdTunnelPrincipal | undefined = directAdmin
        ? {
            kind: "owner",
            peerKey: `iroh:${"ab".repeat(32)}`,
            authority: {
              clawId: "condition-claw",
              rootPub: "condition-root",
              listedSeq: 2,
              ownerDevice: "administrative-device",
            },
          }
        : undefined;
      const lookup = (key: string) =>
        principal?.peerKey === key
          ? principal
          : administrativePeer?.peerKey === key
            ? administrativePeer
            : undefined;
      setOpenClawIdTunnelPrincipalLookup(lookup);
      const context = createContext([
        [
          "cron.update",
          "operator.admin",
          "cron",
          expectDefined(cronHandlers["cron.update"], "native cron.update handler"),
        ],
      ]);
      const fixture = await recoveryFixture(stateDir, profile.id, {
        context,
        openclawIdPrincipal: principal,
        scopes: kind === "owner" ? ["operator.admin"] : ["operator.write"],
      });
      const config = { agents: { defaults: { workspace: path.join(stateDir, "workspace") } } };
      fixture.context.getRuntimeConfig = () => config;
      fixture.context.resolveGatewayContext = () => fixture.context;
      const disposition = vi.fn();
      const effect = vi.fn(async () => jsonResult({ observed: true }));
      let observed: AdmittedRunOperatorAuthority | undefined;
      let sender: ReturnType<typeof readScheduledSenderBit>;
      const payload = vi.fn(async () => ({ status: "ok" as const }));
      const runtime = createCronScriptRuntime({
        config,
        resolveGatewayContext: () => fixture.context,
        prepareRuntime: async (request) => ({
          context: { config, agentId: "main", sessionKey: "agent:main:cron:condition" },
          scheduledToolPolicy: request.scheduledToolPolicy,
          createTools: async (admitted) => {
            // Conditions keep the source policy too, even when no model payload ever starts.
            observed = readAdmittedRunOperatorAuthority(admitted);
            sender = readScheduledSenderBit(admitted);
            return [
              {
                name: "probe",
                label: "Probe",
                description: "Record an effect",
                parameters: { type: "object", properties: {} },
                execute: effect,
              },
            ];
          },
        }),
        runHeadless: async ({ ctx }) => {
          const tools = new ToolSearchRuntime(ctx, resolveToolSearchConfig(ctx.runtimeConfig));
          await tools.callValue("probe", {});
          return { status: "completed", value: { fire: false }, output: [], toolCallCount: 1 };
        },
      });
      const cron = new CronService({
        storePath: path.join(stateDir, "cron", "jobs.json"),
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        defaultAgentId: "main",
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        enqueueSystemEvent: () => {},
        admitScheduledOccurrence: ({ job }) =>
          admitScheduledOccurrence({ cfg: config, job, agentId: "main", trigger: "cron" }),
        evaluateCronTrigger: runtime.evaluateTrigger,
        runIsolatedAgentJob: payload,
      });
      fixture.context.cron = cron;
      try {
        const job = await cron.add(
          {
            name: "Original OCID condition",
            agentId: "main",
            enabled: true,
            schedule: { kind: "every", everyMs: 3_600_000 },
            sessionTarget: target,
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "Must not run", toolsAllow: ["probe"] },
            trigger: { script: "return {fire:false}" },
            owner: { agentId: "main", sessionKey: fixture.target.sessionKey, accountId: "default" },
          },
          {
            createdActor: { type: "human", source: "profile", id: profile.id },
            ...(target === "isolated"
              ? {
                  sourceConversation: {
                    sessionKey: fixture.target.sessionKey,
                    sessionId: fixture.target.sessionId,
                    lifecycleRevision: fixture.entry.lifecycleRevision,
                  },
                }
              : {}),
            operatorSource: {
              version: 1,
              kind: "gateway",
              agentId: "main",
              sourceRunId: "original-turn",
              snapshot: fixture.snapshot,
            },
            scheduledToolPolicy: {
              version: 1,
              mode: "account",
              ownerSessionKey: fixture.target.sessionKey,
              ownerAccountId: "default",
            },
          },
        );
        expect(job.operatorSource).toBeDefined();
        if (reset) {
          await replaceSessionEntry(fixture.target, {
            ...fixture.entry,
            sessionId: "reset-conversation",
            lifecycleRevision: "new-incarnation",
          });
        }
        if (originalRevoked) {
          principal = undefined;
          setOpenClawIdTunnelPrincipalLookup(lookup);
        }
        if (direct) {
          await prepareUserProfileCatalog();
          const client = createOperatorClient({
            profileId: administrativeProfile?.id ?? profile.id,
            scopes: directAdmin ? ["operator.admin"] : ["operator.write"],
          });
          // Socket admission has classified this fixture as independent of plugin access grants.
          client.internal = {
            authenticatedOperator: true,
            openclawIdPrincipal: administrativePeer ?? principal,
            operatorAccessAuthority: null,
          };
          client.authPolicy = captureGatewayAuthPolicy(config, {
            role: "operator",
            authMethod: "trusted-proxy",
          });
          await expect(
            dispatchGatewayRequestInProcess(
              "cron.update",
              { id: job.id, patch: { schedule: { kind: "every", everyMs: 7_200_000 } } },
              {
                client,
                context: fixture.context,
                hasCurrentClientAuthority: () => (administrativePeer ?? principal) !== undefined,
              },
            ),
          ).resolves.toMatchObject({ id: job.id });
          expect(cron.getJob(job.id)?.operatorSource?.source.snapshot.openclawIdPrincipal).toEqual(
            fixture.snapshot.openclawIdPrincipal,
          );
          expect(cron.getJob(job.id)?.schedule).toMatchObject({
            kind: "every",
            everyMs: 7_200_000,
          });
        }
        if (originalRevoked) {
          await cron.run(job.id, "force", {
            evaluateTrigger: true,
            onTriggerDisposition: disposition,
          });
          // The admin's timing edit did not lend its authority to the removed member's task.
          expect(disposition).toHaveBeenLastCalledWith("error");
          expect(effect).not.toHaveBeenCalled();
          return;
        }
        await cron.run(job.id, "force", {
          evaluateTrigger: true,
          onTriggerDisposition: disposition,
        });
        expect(disposition).toHaveBeenLastCalledWith("dropped");
        expect(effect).toHaveBeenCalledOnce();
        expect(payload).not.toHaveBeenCalled();
        principal = undefined;
        setOpenClawIdTunnelPrincipalLookup(lookup);
        await cron.run(job.id, "force", {
          evaluateTrigger: true,
          onTriggerDisposition: disposition,
        });
        expect(disposition).toHaveBeenLastCalledWith("error");
        expect(effect).toHaveBeenCalledOnce();
        expect(payload).not.toHaveBeenCalled();
        expect(observed?.openclawIdPrincipal).toEqual(fixture.snapshot.openclawIdPrincipal);
        expect(sender).toEqual(
          kind === "member" ? { senderIsOwner: false } : target === "main" ? undefined : {},
        );
      } finally {
        cron.stop();
        setOpenClawIdTunnelPrincipalLookup(undefined);
      }
    });
  },
);

function expectCurrent(authority: AdmittedRunOperatorAuthority) {
  expect(authority.signal?.aborted).toBe(false);
  expect(authority.assertCurrent).not.toThrow();
}
function expectRevoked(authority: AdmittedRunOperatorAuthority) {
  expect(authority.assertCurrent).toThrow();
  expect(authority.signal?.aborted).toBe(true);
}
it.each(["member", "owner"] as const)(
  "recovers a serialized OCID %s source without replacing membership with profile authority",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const profile =
        kind === "owner"
          ? await ensureCanonicalGatewayOwnerProfile("Synthetic owner")
          : ensureProfileForEmail("ocid-member@example.test");
      let current: OpenClawIdTunnelPrincipal | undefined =
        kind === "owner"
          ? { kind, peerKey: `iroh:${"ca".repeat(32)}` }
          : {
              kind,
              peerKey: `iroh:${"cb".repeat(32)}`,
              accountId: "acct-recovery",
              role: "operator",
            };
      current.authority = {
        clawId: "recovery-claw",
        rootPub: "recovery-root",
        listedSeq: 7,
        ...(kind === "owner" ? { ownerDevice: "recovery-owner-device" } : {}),
      };
      setOpenClawIdTunnelPrincipalLookup(() => current);
      try {
        const fixture = await recoveryFixture(stateDir, profile.id, {
          openclawIdPrincipal: current,
          config:
            kind === "member"
              ? {
                  gateway: {
                    roles: {
                      default: "reader",
                      definitions: {
                        reader: {
                          sessions: { others: "view" },
                          agents: "*",
                          scopes: ["operator.read"],
                        },
                      },
                    },
                  },
                }
              : {},
          scopes: kind === "owner" ? ["operator.admin"] : ["operator.write", "operator.read"],
        });
        const savedSnapshot = JSON.stringify(fixture.snapshot);
        const snapshot = JSON.parse(savedSnapshot);
        // Replace the resident lookup to represent a new runtime loading the same durable source.
        current = structuredClone(current);
        setOpenClawIdTunnelPrincipalLookup(() => current);
        const restored = await restoreGatewayOperatorSource({
          snapshot,
          target: fixture.target,
          context: fixture.context,
          assertCurrent: () => {},
        });
        try {
          expectCurrent(restored.authority);
          const scheduled = captureScheduledOperatorSource({
            authority: restored.authority,
            entry: fixture.entry,
            agentId: fixture.target.agentId,
            sessionKey: fixture.target.sessionKey,
            sourceRunId: "original-ocid-turn",
          });
          expect(scheduled?.snapshot).toBeDefined();
          if (kind === "member") {
            expect(restored.authority.readCurrentRoleFacts?.().policy?.scopes).toContain(
              "operator.write",
            );
          }
          const original = structuredClone(current);
          // The lookup's lifecycle event also cancels retained work before another tool call.
          setOpenClawIdTunnelPrincipalLookup(undefined);
          expectRevoked(restored.authority);
          await expect(fixture.restore()).rejects.toThrow();
          setOpenClawIdTunnelPrincipalLookup(() => current);
          for (const authority of [
            { ...original.authority!, listedSeq: 8 },
            { ...original.authority!, clawId: "different-claw" },
            { ...original.authority!, rootPub: "different-root" },
          ]) {
            current = { ...original, authority };
            await expect(fixture.restore()).rejects.toThrow();
          }
          if (original.kind === "member") {
            current = { ...original, role: "viewer" };
            await expect(fixture.restore()).rejects.toThrow();
          }
          current = original;
          expectRevoked(restored.authority);
          const reloaded = await fixture.restore();
          try {
            expectCurrent(reloaded.authority);
          } finally {
            reloaded.release();
          }
        } finally {
          restored.release();
        }
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
      }
    });
  },
);

it("keeps owner-only standing within the retained scope and fences control edits to it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const device: OpenClawIdTunnelPrincipal = {
      kind: "owner",
      peerKey: `iroh:${"ce".repeat(32)}`,
      authority: { clawId: "clamp-claw", rootPub: "clamp-root", listedSeq: 1 },
    };
    setOpenClawIdTunnelPrincipalLookup(() => device);
    const context = createContext();
    const profile = await ensureCanonicalGatewayOwnerProfile("Synthetic owner");
    const fixture = (scopes: string[]) =>
      recoveryFixture(stateDir, profile.id, { context, openclawIdPrincipal: device, scopes });
    const broad = await fixture(["operator.admin"]);
    const narrow = await fixture(["operator.write"]);
    const handshake = broad.snapshot;
    if (handshake.sourceIngress === "principal") {
      throw new Error("expected a handshake source");
    }
    const source = (snapshot: typeof broad.snapshot) => ({
      version: 1 as const,
      kind: "gateway" as const,
      agentId: "main",
      sourceRunId: "turn",
      snapshot,
    });
    const cron = new CronService({
      storePath: path.join(stateDir, "cron", "jobs.json"),
      scheduler: createTestGatewayScheduler(),
      cronEnabled: true,
      defaultAgentId: "main",
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      enqueueSystemEvent: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    context.cron = cron;
    context.resolveGatewayContext = () => context;
    try {
      // Failure repair and notices treat a restored Control UI source as owner only under admin scope.
      for (const [scopes, owner] of [
        [["operator.admin"], true],
        [["operator.write"], false],
      ] as const) {
        const restored = await restoreGatewayOperatorSource({
          snapshot: { ...handshake, scopes: [...scopes], controlUiAdmin: true },
          context,
          assertCurrent: () => {},
        });
        try {
          expect(restored.controlUiAdmin).toBe(owner);
        } finally {
          restored.release();
        }
      }
      const job = await cron.add(
        {
          name: "standing ceiling",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "Must not run" },
        },
        { operatorSource: source(narrow.snapshot) },
      );
      const control = retainCronControlSource({
        job,
        patch: { enabled: true },
        capture: {
          operatorSource: source({ ...handshake, controlUiAdmin: true }),
          assertOperatorSourceCurrent: () => {},
        },
        context,
      });
      expect(control.operatorSource?.snapshot.scopes).not.toContain("operator.admin");
      expect(control.operatorSource?.snapshot.controlUiAdmin).toBe(false);
      expect(() => control.assertOperatorSourceCurrent?.()).not.toThrow();
      // A concurrent same-requester edit narrows the standing source before this control commits.
      await cron.update(
        job.id,
        { description: "narrowed elsewhere" },
        {
          operatorSource: source({ ...narrow.snapshot, scopes: ["operator.read"] }),
          operatorSourceExecutionRevision: resolveCronOperatorExecutionRevision(job),
        },
      );
      expect(() => control.assertOperatorSourceCurrent?.()).toThrow("standing scope changed");
    } finally {
      cron.stop();
      setOpenClawIdTunnelPrincipalLookup(undefined);
    }
  });
});
