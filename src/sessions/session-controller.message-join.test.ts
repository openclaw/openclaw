import { afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  bindWorkerToolPreparation,
  isToolAuthorityReadCaptureActive,
} from "../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../agents/harness/tool-authority-preparation.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { withMessageInjectionAdmission } from "../auto-reply/reply/message-injection-authority.js";
import {
  prepareReplyRunToolAuthority,
  prepareReplyToolAuthority,
} from "../auto-reply/reply/reply-tool-authority.js";
import {
  createQueueTestRun,
  toolAuthorityOverlay,
} from "../auto-reply/reply/reply-tool-authority.test-support.js";
import { prepareSteeringDelivery } from "../auto-reply/reply/steering-delivery-preparation.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveRestartRecoveryTerminalDeliveryDisposition } from "../config/sessions/restart-recovery-receipt-state.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withSessionTurn } from "./session-controller.admission.js";
import {
  captureReplyExecutionSelection,
  captureReplySessionExecutionSelection,
} from "./session-controller.execution-selection.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
} from "./session-controller.message-injection.js";
import { prepareReplyMessageJoin } from "./session-controller.message-join.js";
import { testing } from "./session-controller.test-support.js";
import { createReplyTurnParticipants } from "./session-controller.tool-authority.js";

afterEach(() => testing.resetSessionControllerForTest());

it("copies private turn participants and freezes only their shared command target", () => {
  let current = true;
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "participant",
    scopes: ["operator.read"],
    assertCurrent() {
      if (!current) {
        throw new Error("revoked");
      }
    },
  });
  const freeze = vi.spyOn(Object, "freeze");
  const participants = createReplyTurnParticipants({
    operatorAuthority: authority,
    senderId: "original",
    gatewayUiCommandTarget: { connId: "original", profileId: "participant" },
  });
  try {
    expect(freeze).toHaveBeenCalledTimes(1);
    const exposed = participants.resolve()!;
    Object.assign(exposed, { senderId: "changed", name: "changed" });
    expect(Reflect.set(exposed.gatewayUiCommandTarget!, "connId", "changed")).toBe(false);
    expect(participants.resolve()).toMatchObject({
      senderId: "original",
      gatewayUiCommandTarget: { connId: "original", profileId: "participant" },
    });
    current = false;
    expect(() => exposed.assertCurrent()).toThrow("access changed");
  } finally {
    freeze.mockRestore();
    participants.close();
  }
});

type JoinCase = {
  differentConversation?: true;
  predecessor?: boolean | "pending";
  claim?: "before" | "after" | "added";
  source?: false;
  legacy?: true;
  profile?: "pin" | "auto" | "legacy-pin" | "legacy-auto";
  headless?: true;
  caps?: "expand" | "narrow" | "protocol";
  target?: "new" | "removed" | "foreign";
  mismatch?: "profile" | "tools" | "elevation" | "exec" | "workspace" | "cwd" | "scopes";
  after?: "settings" | "activity" | "revoke" | "caller-revoke" | "backend" | "delivery";
  sessionOnly?: true;
};
type Outcome = "accepted" | "deferred" | "rejected" | "revoked";
const recoveryClaim = (id: string) => ({
  restartRecoveryDeliveryRunId: id,
  restartRecoveryDeliverySourceRunId: id,
});
const uiTarget = (connId: string, profileId = "join-owner") => ({ connId, profileId });

it.each<[string, Outcome, JoinCase?]>([
  ["resolved defaults", "accepted"],
  ["retained predecessor", "accepted", { predecessor: true }],
  ["retained predecessor pending", "deferred", { predecessor: "pending" }],
  ["retained predecessor without source", "accepted", { predecessor: true, source: false }],
  ["retained predecessor without observation", "rejected", { predecessor: true, legacy: true }],
  ["claim added after empty observation", "deferred", { claim: "added" }],
  ["claim replaced before preparation", "deferred", { predecessor: true, claim: "before" }],
  [
    "claim replaced before preparation without source",
    "deferred",
    { predecessor: true, claim: "before", source: false },
  ],
  ["claim replaced after preparation", "rejected", { predecessor: true, claim: "after" }],
  [
    "claim replaced after preparation without source",
    "rejected",
    { predecessor: true, claim: "after", source: false },
  ],
  ["unqualified profile pin", "deferred", { profile: "pin" }],
  ["legacy profile pin", "deferred", { profile: "legacy-pin" }],
  ["legacy automatic profile", "accepted", { profile: "legacy-auto" }],
  ["automatic profile rotation", "accepted", { profile: "auto" }],
  ["caps-only", "accepted", { headless: true, caps: "expand" }],
  ["headless-to-web", "accepted", { headless: true, caps: "expand", target: "new" }],
  ["protocol-only", "accepted", { caps: "protocol" }],
  ["narrower caps", "accepted", { caps: "narrow" }],
  [
    "another conversation with changed policy",
    "deferred",
    { mismatch: "tools", differentConversation: true },
  ],
  ["new target", "accepted", { headless: true, target: "new" }],
  ["removed target", "accepted", { target: "removed" }],
  ["changed non-owner target", "accepted", { target: "foreign" }],
  ["cross-profile caps", "deferred", { headless: true, caps: "expand", mismatch: "profile" }],
  ["missing selection compatible", "accepted", { legacy: true }],
  ["missing selection expanded caps", "deferred", { legacy: true, caps: "expand" }],
  ["session-only", "accepted", { sessionOnly: true }],
  ["current tool policy", "accepted", { mismatch: "tools" }],
  ["saved elevation", "deferred", { mismatch: "elevation" }],
  ["exec configuration", "deferred", { mismatch: "exec" }],
  ["workspace", "deferred", { mismatch: "workspace" }],
  ["saved working directory", "deferred", { mismatch: "cwd" }],
  ["narrowed scopes", "accepted", { mismatch: "scopes" }],
  ["revoked after preparation", "revoked", { after: "revoke" }],
  ["incoming authority revoked independently", "rejected", { after: "caller-revoke" }],
  ["replaced backend", "rejected", { after: "backend" }],
  ["saved settings after preparation", "rejected", { after: "settings" }],
  ["activity after preparation", "accepted", { after: "activity" }],
  ["delivery closed before final submission", "rejected", { after: "delivery" }],
])(
  "joins the selected execution with current admission checks: %s",
  async (name, outcome, c = {}) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const key = `agent:main:join-${name.replaceAll(" ", "-")}`;
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const entry: SessionEntry = {
        sessionId: "join-session",
        lifecycleRevision: "join-revision",
        updatedAt: 1,
        permissionMode: "full",
        ...(c.predecessor ? recoveryClaim("unresolved-predecessor") : {}),
        ...(c.predecessor === "pending"
          ? { restartRecoveryDeliveryReceiptState: "terminal-pending" as const }
          : {}),
      };
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const address = { agentId: "main", sessionKey: key, storePath };
      await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
      const run = createQueueTestRun({ prompt: "original work", originatingChannel: "webchat" });
      Object.assign(run.run, {
        agentId: "main",
        agentDir: state.agentDir(),
        sessionKey: key,
        sessionId: entry.sessionId,
        workspaceDir: state.workspaceDir,
        messageProvider: "webchat",
        senderIsOwner: true,
        permissionMode: "full",
        config: cfg,
        traceAuthorized: false,
        clientCaps: c.headless ? [] : ["ui-commands"],
        gatewayUiCommandTarget:
          c.headless || c.caps === "protocol"
            ? undefined
            : uiTarget(
                "original-connection",
                c.target === "foreign" ? "destination-owner" : "join-owner",
              ),
      });
      if (c.profile === "pin" || c.profile === "auto") {
        run.run.authProfileId = "synthetic-profile-a";
        run.run.authProfileIdSource = c.profile === "auto" ? "auto" : undefined;
      }
      const original = structuredClone([run.run.clientCaps, run.run.gatewayUiCommandTarget]);
      const sourceRevocation = new AbortController();
      const assertSource = () => sourceRevocation.signal.throwIfAborted();
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "join-owner",
        scopes: ["operator.admin"],
        gatewayAccessGrant: null,
        modelPolicy: prepareOperatorModelPolicy({ cfg, policy: {} }),
        assertCurrent: assertSource,
      });
      run.operatorAuthority = operatorAuthority;
      await withSessionTurn({ ...address, sessionId: entry.sessionId }, async (operation) => {
        if (!operation) {
          throw new Error("Expected direct execution owner");
        }
        await operation.bindToolAuthoritySnapshotAsync(
          c.legacy ? prepareReplyToolAuthority(run) : prepareReplyRunToolAuthority(run, entry),
        );
        const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
        const delivered = vi.fn();
        const replacement = vi.fn();
        const backend = {
          kind: "embedded" as const,
          toolAuthorityFingerprint: fingerprint,
          terminalReplyExpectation: "required" as const,
          cancel() {},
        };
        operation.attachBackend({
          ...backend,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            async queueMessage() {
              throw new Error("Expected prepared admission");
            },
            async queueMessageAsync(text, options, preparation) {
              await withMessageInjectionAdmission(preparation.prepareCurrent, () => {
                preparation.assertCurrent();
                delivered(text);
                options?.onQueueAccepted?.(true);
              });
            },
          },
        });
        operation.setPhase("running");
        const originalParticipant = structuredClone(
          operation.personalToolParticipants?.resolve()?.gatewayUiCommandTarget,
        );
        const target = captureReplyMessageInjectionTarget(operation);
        if (!target) {
          throw new Error("Expected captured target");
        }
        const incoming: typeof run = {
          ...run,
          prompt: "change the current work",
          run: {
            ...run.run,
            ...(c.legacy
              ? {}
              : {
                  traceAuthorized: true,
                  elevatedLevel: "off" as const,
                  bashElevated: { enabled: true, allowed: false, defaultLevel: "off" as const },
                }),
          },
        };
        const incomingRevocation = new AbortController();
        if (c.after === "caller-revoke") {
          incoming.operatorAuthority = createAdmittedRunOperatorAuthority({
            ...operatorAuthority,
            source: {},
            assertCurrent: () => incomingRevocation.signal.throwIfAborted(),
          });
        }
        if (c.caps) {
          incoming.run.clientCaps = c.caps === "narrow" ? [] : ["ui-commands", "usage-refreshing"];
        }
        if (c.differentConversation) {
          incoming.run.conversationId = "different-conversation";
        }
        if (c.target) {
          incoming.run.gatewayUiCommandTarget =
            c.target === "removed"
              ? undefined
              : c.target === "foreign"
                ? uiTarget("other-destination", "different-destination-owner")
                : uiTarget("new-connection");
        }
        if (c.profile === "pin" || c.profile === "auto") {
          incoming.run.authProfileId = "synthetic-profile-b";
        }
        if (c.mismatch === "tools") {
          incoming.run.config = { ...cfg, tools: { deny: ["exec"] } };
        }
        if (c.mismatch === "exec") {
          incoming.run.config = { ...cfg, tools: { exec: { security: "deny" } } };
        }
        if (c.mismatch === "workspace") {
          incoming.run.workspaceDir = `${state.workspaceDir}/other`;
        }
        if (c.mismatch === "profile" || c.mismatch === "scopes") {
          incoming.operatorAuthority = createAdmittedRunOperatorAuthority({
            ...operatorAuthority,
            ...(c.mismatch === "profile"
              ? { profileId: "another-owner" }
              : { scopes: ["operator.read"] }),
          });
        }
        let currentEntry = entry;
        if (c.profile === "legacy-pin" || c.profile === "legacy-auto") {
          currentEntry = {
            ...entry,
            authProfileOverride: "synthetic-legacy-profile",
            authProfileOverrideCompactionCount: c.profile === "legacy-auto" ? 0 : undefined,
          };
        }
        if (c.mismatch === "elevation") {
          currentEntry = { ...entry, elevatedLevel: "full" };
        }
        if (c.mismatch === "cwd") {
          currentEntry = { ...entry, spawnedCwd: `${state.workspaceDir}/other` };
        }
        if (c.claim === "before" || c.claim === "added") {
          currentEntry = { ...entry, ...recoveryClaim("later-source") };
          await upsertSessionEntryCore(address, currentEntry);
        }
        const incomingShape = structuredClone([
          incoming.run.clientCaps,
          incoming.run.gatewayUiCommandTarget,
        ]);
        const assertFrozen = () => {
          expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
          expect([
            run.run.clientCaps,
            run.run.gatewayUiCommandTarget,
            operation.personalToolParticipants?.resolve()?.gatewayUiCommandTarget,
          ]).toEqual([...original, originalParticipant]);
          expect([incoming.run.clientCaps, incoming.run.gatewayUiCommandTarget]).toEqual(
            incomingShape,
          );
        };
        const {
          traceAuthorized: _trace,
          allowCollaborativeSteering: _collaboration,
          ...caller
        } = toolAuthorityOverlay(incoming);
        const delivery = prepareSteeringDelivery({
          ...address,
          sessionId: entry.sessionId,
          sourceTurnId: c.source === false ? undefined : "current-execution",
          entry: currentEntry,
          assertCurrent: assertSource,
        });
        const joined = await prepareReplyMessageJoin({
          followupRun: incoming,
          operation,
          target,
          assertCurrent: assertSource,
          delivery,
          continuation: {
            kind: "continuation",
            caller,
            config: incoming.run.config,
            selectedRoute: { provider: incoming.run.provider, model: incoming.run.model },
            fallbackAvailability: { kind: "none_configured", source: "inherited" },
            executionSelection: c.sessionOnly
              ? captureReplySessionExecutionSelection({
                  config: cfg,
                  agentId: "main",
                  sessionEntry: currentEntry,
                })
              : captureReplyExecutionSelection({ run: incoming.run, sessionEntry: currentEntry }),
          },
        });
        expect(joined.kind).toBe(outcome === "deferred" ? "deferred" : "prepared");
        if (c.claim === "added") {
          expect(joined).toMatchObject({ kind: "deferred", reason: "reply-owner-ended" });
        }
        assertFrozen();
        if (joined.kind !== "prepared") {
          expect(delivered).not.toHaveBeenCalled();
          return;
        }
        if (c.after === "revoke") {
          sourceRevocation.abort(new Error("Caller revoked"));
        }
        if (c.after === "settings" || c.after === "activity") {
          const settings = c.after === "settings";
          const updated = await patchSessionEntryCore(address, () =>
            settings ? { elevatedLevel: "full" } : { updatedAt: 2 },
          );
          expect(updated).toMatchObject({
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            ...(settings ? { elevatedLevel: "full" } : {}),
          });
          if (!settings) {
            expect(updated?.updatedAt).toBeGreaterThan(entry.updatedAt);
          }
        }
        if (c.claim === "after") {
          await patchSessionEntryCore(address, () => recoveryClaim("later-source"));
        }
        if (c.after === "backend") {
          operation.attachBackend({ ...backend, queueMessage: replacement });
        }
        try {
          if (c.after === "caller-revoke") {
            incomingRevocation.abort(new Error("Incoming caller revoked"));
            assertSource();
            operatorAuthority.assertCurrent();
            await expect(joined.prepareCurrent()).rejects.toThrow("Incoming caller revoked");
            expect(delivered).not.toHaveBeenCalled();
            assertFrozen();
            return;
          }
          if (outcome === "revoked") {
            const refused = await beginReplyMessageInjectionTarget(target, incoming.prompt, {
              assertCurrent: assertSource,
            });
            expect(await refused.acceptance).toBe(false);
            expect(await refused.outcome).toMatchObject({
              status: "failed",
              error: expect.objectContaining({ message: "Caller revoked" }),
            });
            expect(delivered).not.toHaveBeenCalled();
            expect(replacement).not.toHaveBeenCalled();
            return;
          }
          const readAuthority = joined.toolAuthority.read;
          const closed = c.after === "delivery";
          const unobserved = c.predecessor && c.legacy;
          const attempt = await beginReplyMessageInjectionTarget(target, incoming.prompt, {
            assertCurrent: assertSource,
            isInboundUserMessage: true,
            terminalReplyExpectation: "required",
            toolAuthorityFingerprint: joined.toolAuthorityFingerprint,
            toolAuthorityPreparation: bindPreparedToolAuthority(
              bindWorkerToolPreparation({
                authorityKind: "source-bound" as const,
                assertCurrent: closed ? assertSource : readAuthority,
                compatAssertCurrent: readAuthority,
                prepareCurrent:
                  closed || unobserved
                    ? async () => {
                        await joined.prepareCurrent();
                        if (closed) {
                          if (isToolAuthorityReadCaptureActive()) {
                            delivery.release();
                          }
                        } else {
                          await delivery.prepareCurrent();
                        }
                      }
                    : joined.prepareCurrent,
              }),
            ),
          });
          expect((await attempt.outcome).status).toBe(outcome);
          expect(delivered).toHaveBeenCalledTimes(outcome === "rejected" ? 0 : 1);
          expect(replacement).not.toHaveBeenCalled();
          assertFrozen();
        } finally {
          joined.toolAuthority.release();
        }
      });
      if (name === "retained predecessor") {
        const retained = loadSessionEntry(address);
        expect(
          resolveRestartRecoveryTerminalDeliveryDisposition(retained, {
            sessionId: entry.sessionId,
            sourceTurnId: "current-execution",
          }),
        ).toBe("stale");
        expect(retained).toMatchObject(recoveryClaim("unresolved-predecessor"));
      }
    });
  },
);
