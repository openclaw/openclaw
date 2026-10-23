import { afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { bindWorkerToolPreparation } from "../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../agents/harness/tool-authority-preparation.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { withMessageInjectionAdmission } from "../auto-reply/reply/message-injection-authority.js";
import { prepareReplyToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import {
  createQueueTestRun,
  toolAuthorityOverlay,
} from "../auto-reply/reply/reply-tool-authority.test-support.js";
import { prepareSteeringDelivery } from "../auto-reply/reply/steering-delivery-preparation.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
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

afterEach(() => testing.resetSessionControllerForTest());

it.each([
  "resolved defaults",
  "unqualified profile pin",
  "legacy profile pin",
  "legacy automatic profile",
  "automatic profile rotation",
  "caps-only",
  "headless-to-web",
  "protocol-only",
  "narrower caps",
  "new target",
  "removed target",
  "changed non-owner target",
  "changed binding",
  "cross-profile caps",
  "missing selection compatible",
  "missing selection expanded caps",
  "session-only",
  "current tool policy",
  "saved elevation",
  "exec configuration",
  "workspace",
  "saved working directory",
  "narrowed scopes",
  "revoked after preparation",
  "replaced backend",
  "saved settings after preparation",
  "activity after preparation",
] as const)("joins the selected execution with current admission checks: %s", async (change) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const key = `agent:main:join-${change.replaceAll(" ", "-")}`;
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const entry: SessionEntry = {
      sessionId: "join-session",
      lifecycleRevision: "join-revision",
      updatedAt: 1,
      permissionMode: "full",
    };
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
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
    });
    if (change === "unqualified profile pin" || change === "automatic profile rotation") {
      run.run.authProfileId = "synthetic-profile-a";
      run.run.authProfileIdSource = change === "automatic profile rotation" ? "auto" : undefined;
    }
    const headless = ["caps-only", "headless-to-web", "new target", "cross-profile caps"].includes(
      change,
    );
    const noTarget = headless || change === "protocol-only";
    const nonOwnerTarget = change === "changed non-owner target";
    Object.assign(run.run, {
      clientCaps: headless ? [] : ["ui-commands"],
      gatewayUiCommandTarget: noTarget
        ? undefined
        : {
            connId: "original-connection",
            profileId: nonOwnerTarget ? "destination-owner" : "join-owner",
          },
    });
    const originalCaps = structuredClone(run.run.clientCaps);
    const originalTarget = structuredClone(run.run.gatewayUiCommandTarget);
    let sourceCurrent = true;
    const assertSource = () => {
      if (!sourceCurrent) {
        throw new Error("Caller revoked");
      }
    };
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "join-owner",
      scopes: ["operator.admin"],
      gatewayAccessGrant: null,
      modelPolicy: prepareOperatorModelPolicy({ cfg, policy: {} }),
      assertCurrent: assertSource,
    });
    run.operatorAuthority = operatorAuthority;
    await withSessionTurn(
      { sessionKey: key, sessionId: entry.sessionId, agentId: "main", storePath },
      async (operation) => {
        if (!operation) {
          throw new Error("Expected direct execution owner");
        }
        await operation.bindToolAuthoritySnapshotAsync(
          prepareReplyToolAuthority({
            ...run,
            executionSelection: change.startsWith("missing selection")
              ? undefined
              : captureReplyExecutionSelection({
                  run: run.run,
                  sessionEntry: entry,
                }),
          }),
        );
        const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
        const delivered = vi.fn();
        const replacement = vi.fn();
        operation.attachBackend({
          kind: "embedded",
          toolAuthorityFingerprint: fingerprint,
          terminalReplyExpectation: "required",
          cancel() {},
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
        const originalParticipant = operation.personalToolParticipants?.resolve();
        const originalParticipantTarget = structuredClone(
          originalParticipant?.gatewayUiCommandTarget,
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
            traceAuthorized: true,
            elevatedLevel: "off" as const,
            bashElevated: {
              enabled: true,
              allowed: false,
              defaultLevel: "off" as const,
            },
          },
        };
        const unchangedLegacy = change.startsWith("missing selection");
        if (unchangedLegacy) {
          incoming.run.traceAuthorized = run.run.traceAuthorized;
          incoming.run.elevatedLevel = run.run.elevatedLevel;
          incoming.run.bashElevated = run.run.bashElevated;
        }
        if (
          [
            "caps-only",
            "headless-to-web",
            "cross-profile caps",
            "missing selection expanded caps",
          ].includes(change)
        ) {
          incoming.run.clientCaps = [
            ...(run.run.clientCaps ?? []),
            "ui-commands",
            "usage-refreshing",
          ];
        }
        if (change === "protocol-only") {
          incoming.run.clientCaps = ["ui-commands", "usage-refreshing"];
        }
        if (change === "narrower caps") {
          incoming.run.clientCaps = [];
        }
        if (["headless-to-web", "new target"].includes(change)) {
          incoming.run.gatewayUiCommandTarget = {
            connId: "new-connection",
            profileId: "join-owner",
          };
        }
        if (change === "removed target") {
          incoming.run.gatewayUiCommandTarget = undefined;
        }
        if (change === "changed non-owner target") {
          incoming.run.gatewayUiCommandTarget = {
            connId: "other-destination",
            profileId: "different-destination-owner",
          };
        }
        if (change === "changed binding") {
          incoming.run.toolBindings = { synthetic: "different-binding" };
        }
        if (change === "cross-profile caps") {
          incoming.operatorAuthority = createAdmittedRunOperatorAuthority({
            ...operatorAuthority,
            profileId: "another-owner",
          });
        }
        const incomingCaps = structuredClone(incoming.run.clientCaps);
        const incomingTarget = structuredClone(incoming.run.gatewayUiCommandTarget);
        const assertFrozenParticipants = () => {
          expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
          expect(run.run.clientCaps).toEqual(originalCaps);
          expect(run.run.gatewayUiCommandTarget).toEqual(originalTarget);
          expect(incoming.run.clientCaps).toEqual(incomingCaps);
          expect(incoming.run.gatewayUiCommandTarget).toEqual(incomingTarget);
          expect(operation.personalToolParticipants?.resolve()?.gatewayUiCommandTarget).toEqual(
            originalParticipantTarget,
          );
        };
        let currentEntry = entry;
        if (change === "unqualified profile pin" || change === "automatic profile rotation") {
          incoming.run.authProfileId = "synthetic-profile-b";
        }
        if (change === "legacy profile pin" || change === "legacy automatic profile") {
          currentEntry = {
            ...entry,
            authProfileOverride: "synthetic-legacy-profile",
            authProfileOverrideCompactionCount:
              change === "legacy automatic profile" ? 0 : undefined,
          };
        }
        if (change === "current tool policy") {
          incoming.run.config = { ...cfg, tools: { deny: ["exec"] } };
        }
        if (change === "saved elevation") {
          currentEntry = { ...entry, elevatedLevel: "full" };
        }
        if (change === "exec configuration") {
          incoming.run.config = { ...cfg, tools: { exec: { security: "deny" } } };
        }
        if (change === "workspace") {
          incoming.run.workspaceDir = `${state.workspaceDir}/other`;
        }
        if (change === "saved working directory") {
          currentEntry = { ...entry, spawnedCwd: `${state.workspaceDir}/other` };
        }
        if (change === "narrowed scopes") {
          incoming.operatorAuthority = createAdmittedRunOperatorAuthority({
            ...operatorAuthority,
            scopes: ["operator.read"],
          });
        }
        const {
          traceAuthorized: _trace,
          allowCollaborativeSteering: _collaboration,
          ...caller
        } = toolAuthorityOverlay(incoming);
        const joined = await prepareReplyMessageJoin({
          followupRun: incoming,
          operation,
          target,
          assertCurrent: assertSource,
          continuation: {
            kind: "continuation",
            caller,
            config: incoming.run.config,
            delivery: prepareSteeringDelivery({
              agentId: "main",
              storePath,
              sessionKey: key,
              sessionId: entry.sessionId,
              entry: currentEntry,
              assertCurrent: assertSource,
            }),
            selectedRoute: { provider: incoming.run.provider, model: incoming.run.model },
            fallbackAvailability: { kind: "none_configured", source: "inherited" },
            executionSelection:
              change === "session-only"
                ? captureReplySessionExecutionSelection({
                    config: cfg,
                    agentId: "main",
                    sessionEntry: currentEntry,
                  })
                : captureReplyExecutionSelection({ run: incoming.run, sessionEntry: currentEntry }),
          },
        });
        const allowed = [
          "resolved defaults",
          "legacy automatic profile",
          "automatic profile rotation",
          "caps-only",
          "headless-to-web",
          "protocol-only",
          "new target",
          "missing selection compatible",
          "session-only",
          "revoked after preparation",
          "replaced backend",
          "saved settings after preparation",
          "activity after preparation",
        ].includes(change);
        expect(joined.kind).toBe(allowed ? "prepared" : "deferred");
        assertFrozenParticipants();
        if (joined.kind !== "prepared") {
          expect(delivered).not.toHaveBeenCalled();
          return;
        }
        if (change === "revoked after preparation") {
          sourceCurrent = false;
        }
        if (
          change === "saved settings after preparation" ||
          change === "activity after preparation"
        ) {
          const updated = await patchSessionEntryCore(
            { agentId: "main", sessionKey: key, storePath },
            () =>
              change === "saved settings after preparation"
                ? { elevatedLevel: "full" }
                : { updatedAt: 2 },
          );
          expect(updated).toMatchObject({
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            ...(change === "saved settings after preparation" ? { elevatedLevel: "full" } : {}),
          });
          if (change === "activity after preparation") {
            expect(updated?.updatedAt).toBeGreaterThan(entry.updatedAt);
          }
        }
        if (change === "replaced backend") {
          operation.attachBackend({
            kind: "embedded",
            toolAuthorityFingerprint: fingerprint,
            terminalReplyExpectation: "required",
            cancel() {},
            queueMessage: replacement,
          });
        }
        try {
          if (change === "revoked after preparation") {
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
          const attempt = await beginReplyMessageInjectionTarget(target, incoming.prompt, {
            assertCurrent: assertSource,
            isInboundUserMessage: true,
            terminalReplyExpectation: "required",
            toolAuthorityFingerprint: joined.toolAuthorityFingerprint,
            toolAuthorityPreparation: bindPreparedToolAuthority(
              bindWorkerToolPreparation({
                authorityKind: "source-bound" as const,
                assertCurrent: () => {
                  joined.toolAuthority.read();
                },
                compatAssertCurrent: () => {
                  joined.toolAuthority.read();
                },
                prepareCurrent: joined.prepareCurrent,
              }),
            ),
          });
          const outcome = await attempt.outcome;
          const rejected =
            change === "replaced backend" || change === "saved settings after preparation";
          expect(outcome.status).toBe(rejected ? "rejected" : "accepted");
          expect(delivered).toHaveBeenCalledTimes(rejected ? 0 : 1);
          expect(replacement).not.toHaveBeenCalled();
          assertFrozenParticipants();
        } finally {
          joined.toolAuthority.release();
        }
      },
    );
  });
});
