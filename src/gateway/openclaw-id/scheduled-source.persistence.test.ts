import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { readAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { captureScheduledOperatorSource } from "../../agents/operator-run-recovery-source.js";
import { ToolSearchRuntime } from "../../agents/tool-search-runtime.js";
import { resolveToolSearchConfig } from "../../agents/tool-search.js";
import { jsonResult } from "../../agents/tools/common.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { admitScheduledOccurrence } from "../../cron/execution-context-admission.js";
import { readScheduledSenderBit } from "../../cron/execution-context-registry.js";
import { CronService } from "../../cron/service.js";
import { resolveCronOperatorExecutionRevision } from "../../cron/service/jobs-tool-policy.js";
import { createCronScriptRuntime } from "../../cron/trigger-script.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForOpenClawIdIdentity,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { retainCronControlSource } from "../cron-operator-source.js";
import { restoreGatewayOperatorSource } from "../operator-run-recovery.js";
import { expectCurrent, recoveryFixture } from "../operator-run-recovery.test-support.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import { cronHandlers } from "../server-methods/cron.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { MEMBER_ROLE_PRESETS } from "./member-role-presets.test-support.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

afterEach(() => {
  setOpenClawIdTunnelPrincipalLookup(undefined);
  setOpenClawIdMemberAccountLookup(undefined);
});

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
  // The same account's other device, or the original device reapproved, edits only timing.
  { kind: "member", target: "isolated", reset: false, direct: true, editor: "sibling" },
  { kind: "owner", target: "isolated", reset: false, direct: true, editor: "sibling" },
  {
    kind: "member",
    target: "isolated",
    reset: false,
    direct: true,
    editor: "reapproved",
    originalRevoked: true,
  },
] as const)(
  "keeps OCID $kind condition authority (target=$target reset=$reset directEdit=$direct directAdmin=$directAdmin editor=$editor originalRevoked=$originalRevoked)",
  async (scenario) => {
    const { kind, target, reset, direct } = scenario;
    const directAdmin = "directAdmin" in scenario && scenario.directAdmin;
    const editor = "editor" in scenario ? scenario.editor : undefined;
    const originalRevoked = "originalRevoked" in scenario && scenario.originalRevoked;
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const config = {
        gateway: { openclawId: { enabled: true }, roles: { definitions: MEMBER_ROLE_PRESETS } },
        agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
      };
      setRuntimeConfigSnapshot(config);
      const profile =
        kind === "owner"
          ? await ensureCanonicalGatewayOwnerProfile("Synthetic owner")
          : await ensureCanonicalUserProfileForOpenClawIdIdentity({
              accountId: "condition-member",
              email: "condition-member@example.test",
            });
      if (kind === "member") {
        await setCanonicalUserProfileRole(profile.id, "operator");
      }
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
      const original = principal;
      const editingPeer: OpenClawIdTunnelPrincipal | undefined = directAdmin
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
        : editor
          ? {
              ...original,
              peerKey: editor === "sibling" ? `iroh:${"ac".repeat(32)}` : original.peerKey,
              authority: { ...original.authority!, listedSeq: 2 },
            }
          : undefined;
      const lookup = (key: string) =>
        principal?.peerKey === key
          ? principal
          : editingPeer?.peerKey === key
            ? editingPeer
            : undefined;
      setOpenClawIdMemberAccountLookup((accountId) =>
        [principal, editingPeer].some(
          (peer) => peer?.kind === "member" && peer.accountId === accountId,
        ),
      );
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
        config,
        openclawIdPrincipal: principal,
        scopes: kind === "owner" ? ["operator.admin"] : ["operator.write"],
      });
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
          using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
          const client = createOperatorClient({
            profileId: administrativeProfile?.id ?? profile.id,
            scopes: directAdmin || kind === "owner" ? ["operator.admin"] : ["operator.write"],
          });
          // Socket admission has classified this fixture as independent of plugin access grants.
          client.internal = {
            authenticatedOperator: true,
            openclawIdPrincipal: editingPeer ?? principal,
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
                hasCurrentClientAuthority: () => (editingPeer ?? principal) !== undefined,
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

it.each(["member", "owner"] as const)(
  "keeps an admitted serialized OCID %s request while refusing stale source recovery",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      setRuntimeConfigSnapshot({
        gateway: { openclawId: { enabled: true }, roles: { definitions: MEMBER_ROLE_PRESETS } },
      });
      const profile =
        kind === "owner"
          ? await ensureCanonicalGatewayOwnerProfile("Synthetic owner")
          : await ensureCanonicalUserProfileForOpenClawIdIdentity({
              accountId: "acct-recovery",
              email: "ocid-member@example.test",
            });
      let current: OpenClawIdTunnelPrincipal | undefined =
        kind === "owner"
          ? { kind, peerKey: `iroh:${"ca".repeat(32)}` }
          : {
              kind,
              peerKey: `iroh:${"cb".repeat(32)}`,
              accountId: "acct-recovery",
              role: "operator",
            };
      if (kind === "member") {
        await setCanonicalUserProfileRole(profile.id, "operator");
      }
      current.authority = {
        clawId: "recovery-claw",
        rootPub: "recovery-root",
        listedSeq: 7,
        ...(kind === "owner" ? { ownerDevice: "recovery-owner-device" } : {}),
      };
      setOpenClawIdMemberAccountLookup(
        (accountId) => current?.kind === "member" && current.accountId === accountId,
      );
      setOpenClawIdTunnelPrincipalLookup(() => current);
      try {
        const fixture = await recoveryFixture(stateDir, profile.id, {
          openclawIdPrincipal: current,
          config:
            kind === "member"
              ? {
                  gateway: {
                    openclawId: { enabled: true },
                    roles: {
                      default: "reader",
                      definitions: {
                        ...MEMBER_ROLE_PRESETS,
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
            expect(restored.authority.readCurrentRoleFacts?.().assignedRole).toBe("operator");
            expect(restored.authority.rolePolicy?.sessionAccessCap).toBe("write");
            expect(restored.authority.scopes).toContain("operator.write");
          }
          const original = structuredClone(current);
          // Both certificate and membership loss refuse fresh starts, not admitted requests.
          setOpenClawIdTunnelPrincipalLookup(undefined);
          expectCurrent(restored.authority);
          expect(restored.authority.reauthorize).toThrow();
          await expect(fixture.restore()).rejects.toThrow();
          setOpenClawIdTunnelPrincipalLookup(() => current);
          for (const authority of [
            { ...original.authority!, listedSeq: 8 },
            { ...original.authority!, clawId: "different-claw" },
            { ...original.authority!, rootPub: "different-root" },
          ]) {
            current = { ...original, authority };
            await expect(fixture.restore()).rejects.toThrow();
            expect(restored.authority.reauthorize).toThrow();
            expectCurrent(restored.authority);
          }
          if (original.kind === "member") {
            current = { ...original, role: "viewer" };
            // Membership labels do not replace the canonical profile's operator role.
            const relabeled = await fixture.restore();
            try {
              expectCurrent(relabeled.authority);
              expect(relabeled.authority.readCurrentRoleFacts?.().assignedRole).toBe("operator");
              expect(relabeled.authority.rolePolicy?.sessionAccessCap).toBe("write");
              expect(relabeled.authority.scopes).toContain("operator.write");
            } finally {
              relabeled.release();
            }
            expect(restored.authority.reauthorize).not.toThrow();
            expectCurrent(restored.authority);
          }
          current = original;
          expectCurrent(restored.authority);
          expect(restored.authority.reauthorize).not.toThrow();
          const reloaded = await fixture.restore();
          try {
            expectCurrent(reloaded.authority);
          } finally {
            reloaded.release();
          }
        } finally {
          restored.release();
        }
        expect(restored.authority.assertCurrent).toThrow(
          "Restart recovery operator authority is no longer active.",
        );
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
      }
    });
  },
);

it("keeps owner-only standing within the retained scope and fences control edits to it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    setRuntimeConfigSnapshot({
      gateway: { roles: { definitions: MEMBER_ROLE_PRESETS } },
    });
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
