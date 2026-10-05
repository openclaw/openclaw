import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { readAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as attempts from "../../agents/command/attempt-execution.runtime.js";
import {
  createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../agents/prepared-model-runtime.js";
import { createMainRestartRecoveryCycle } from "../../config/sessions/main-session-recovery.types.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  readSessionPendingInputStage,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import * as pendingStore from "../../config/sessions/session-pending-input-store.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionRecoverHandlers } from "./sessions-recover.js";

afterEach(async () => {
  await closeSkillsWatchers(true);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  "recover",
  "cancelled",
  "effect",
  "opaque capacity",
  "live owner",
  "foreign issuer",
  "late role revoke",
  "late lifecycle change",
  "late Goal completion",
  "mutation await role revoke",
  "committed shutdown",
  "committed foreign issuer",
  "committed mutation await role revoke",
  "committed untrusted sender",
  "committed effect",
  "committed predecessor effect",
  "committed cross-turn result",
  "committed newer pending",
] as const)("server-held accepted input recovery preserves original custody: %s", async (mode) => {
  await withOpenClawTestState({ label: "server-held-recovery" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const fixture = await createOriginalIssuerFixture(state, 17, "current");
    await state.writeConfig(fixture.cfg);
    const sessionKey = "agent:main:dashboard:server-held-input";
    const sessionId = "same-interrupted-session";
    const runId = "accepted-browser-run";
    const target = { agentId: "main", sessionKey };
    const repository = await getSessionRepositoryWorkspaceStore().create({
      ...target,
      url: "https://microsoft.ghe.com/acme/accepted.git",
      requestedRef: "clawson/impacted-validation-phase-0",
      runSetupScript: false,
      assertCurrent: fixture.original!.authority.assertCurrent,
    });
    const issuer = expectDefined(
      fixture.original!.authority.captureRestartRecoveryIssuer?.(),
      "authenticated fixture issuer",
    );
    const predecessor = {
      sessionId,
      sessionKey,
      lifecycleRevision: "same-revision",
      lifecycleGeneration: "previous-process",
      runId: "missing-predecessor",
      inputId: "missing-original-input",
      idempotencyKey: "missing-predecessor:user",
      repositoryWorkspaceId: repository.workspaceId,
      issuer,
    };
    const goal = {
      schemaVersion: 1 as const,
      id: "manual-goal",
      objective: "Keep original work",
      status: "paused" as const,
      createdAt: 1,
      updatedAt: 2,
      pausedAt: 2,
      tokenStart: 0,
      tokensUsed: 12,
      continuationTurns: 3,
    };
    await replaceSessionEntry(target, {
      sessionId,
      lifecycleRevision: predecessor.lifecycleRevision,
      updatedAt: 3,
      createdActor: { type: "human", source: "profile", id: fixture.profile.id },
      repositoryWorkspaceId: repository.workspaceId,
      status: "interrupted",
      abortedLastRun: true,
      goal,
      goalPauseOrigin: "manual",
      mainRestartRecovery: {
        ...createMainRestartRecoveryCycle(),
        turnIntent: predecessor,
      },
    });
    const scope = { ...target, sessionId };
    const text = "Run the originally accepted next command on the saved branch";
    const committedMode = mode.startsWith("committed ");
    if (committedMode) {
      const older = await stageSessionPendingInput(scope, {
        runId: "older-pending-run",
        message: {
          role: "user",
          content: "Earlier unresolved accepted input",
          timestamp: 1,
          idempotencyKey: "older-pending-run:user",
        },
        assertCurrent: fixture.original!.authority.assertCurrent,
        turnIssuerAdmission: {
          assertCurrent: fixture.original!.authority.assertCurrent,
          capture: (entry, input) => ({
            ...predecessor,
            ...entry,
            ...input,
            runId: "older-pending-run",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          }),
        },
      });
      older!.finish("interrupted");
      await older!.settled?.();
    }
    const receipt = await stageSessionPendingInput(scope, {
      runId,
      message: {
        role: "user",
        content: text,
        timestamp: 4,
        idempotencyKey: `${runId}:user`,
        ...(committedMode
          ? {
              __openclaw: {
                senderId: fixture.profile.id,
                senderIdentity: {
                  type: mode === "committed untrusted sender" ? "observation" : "profile",
                  id: fixture.profile.id,
                },
                senderIsOwner: true,
              },
            }
          : {}),
      },
      assertCurrent: fixture.original!.authority.assertCurrent,
      trackCompletion: true,
      turnIssuerAdmission: {
        assertCurrent: fixture.original!.authority.assertCurrent,
        capture: (entry, input) => ({
          ...predecessor,
          ...entry,
          ...input,
          runId,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        }),
      },
    });
    expect(receipt).toBeDefined();
    if (committedMode) {
      if (mode === "committed predecessor effect" || mode === "committed cross-turn result") {
        await appendTranscriptMessage(scope, {
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "same-provider-call-id",
                name: "github",
                arguments: { action: "create_issue" },
              },
            ],
          },
        });
      }
      await receipt!.runAsync!(() => appendTranscriptMessage(scope, { message: receipt!.message }));
      if (mode === "committed cross-turn result") {
        await appendTranscriptMessage(scope, {
          message: {
            role: "toolResult",
            toolCallId: "same-provider-call-id",
            toolName: "github",
            content: [{ type: "text", text: "A result in another user turn" }],
          },
        });
      }
      if (mode === "committed newer pending") {
        const newer = await stageSessionPendingInput(scope, {
          runId: "newer-pending-run",
          message: {
            role: "user",
            content: "A newer accepted instruction",
            timestamp: 6,
            idempotencyKey: "newer-pending-run:user",
          },
          assertCurrent: fixture.original!.authority.assertCurrent,
          turnIssuerAdmission: {
            assertCurrent: fixture.original!.authority.assertCurrent,
            capture: (entry, input) => ({
              ...predecessor,
              ...entry,
              ...input,
              runId: "newer-pending-run",
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            }),
          },
        });
        newer!.finish("interrupted");
        await newer!.settled?.();
      }
    }
    receipt!.finish(mode === "cancelled" ? "cancelled" : "interrupted");
    await receipt!.settled?.();
    if (mode === "recover") {
      const follower = await stageSessionPendingInput(scope, {
        runId: "accepted-follower",
        message: {
          role: "user",
          content: "Next accepted FIFO item",
          timestamp: 5,
          idempotencyKey: "accepted-follower:user",
        },
        assertCurrent: fixture.original!.authority.assertCurrent,
        turnIssuerAdmission: {
          assertCurrent: fixture.original!.authority.assertCurrent,
          capture: (entry, input) => ({
            ...predecessor,
            ...entry,
            ...input,
            runId: "accepted-follower",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          }),
        },
      });
      follower!.finish("interrupted");
      await follower!.settled?.();
    }
    rotateAgentEventLifecycleGeneration();
    await closeOpenClawAgentDatabasesAsync();
    const before = loadSessionEntry(target)!;
    expect(before.mainRestartRecovery?.turnIntent).toEqual(predecessor);
    if (!committedMode) {
      expect(
        (await readSessionPendingInputStage(scope, `${runId}:user`, () => {})).existing
          ?.consumed_event_id,
      ).toBeNull();
    }
    if (committedMode) {
      expect(
        (await readSessionPendingInputStage(scope, `${runId}:user`, () => {})).committed?.messageId,
      ).toBe(receipt!.inputId);
      expect(
        (await readSessionPendingInputStage(scope, `${runId}:user`, () => {})).existing,
      ).toBeUndefined();
    }
    if (mode === "effect" || mode === "committed effect") {
      await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "unresolved-remote-write",
              name: "github",
              arguments: { action: "create_issue" },
            },
          ],
        },
      });
    }
    if (mode === "opaque capacity") {
      await replaceSessionEntry(target, {
        ...before,
        mainRestartRecovery: {
          ...before.mainRestartRecovery!,
          capacityWait: {
            runId: "opaque-allocation",
            lifecycleGeneration: "old",
            sinceMs: 5,
            provider: {
              kind: "settled-shortage-v1",
              environmentId: "",
              ownerEpoch: 0,
              placementGeneration: 1,
              providerId: "fixture",
              profileId: "fixture",
              operationId: "",
              leaseId: "",
              attemptName: "",
              attemptNonce: "",
              providerCode: "",
              attempt: 1,
            },
          },
        },
      });
    }
    if (mode === "foreign issuer" || mode === "committed foreign issuer") {
      fixture.client.authenticatedFactoryGitHubAccountId = 999999;
    }
    let lease: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    if (mode === "live owner") {
      const facts = await readSessionPendingInputStage(scope, `${runId}:user`, () => {});
      const { resolveGatewaySessionStoreTargetInWorker } =
        await import("../session-utils-store-worker.js");
      const store = await resolveGatewaySessionStoreTargetInWorker({
        cfg: fixture.cfg,
        key: sessionKey,
      });
      expect(facts.current).toBe(true);
      lease = await beginSessionWorkAdmission({
        scope: store.storePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
    }
    if (
      mode === "late role revoke" ||
      mode === "late lifecycle change" ||
      mode === "late Goal completion"
    ) {
      const prepare = fixture.runtime.recovery.prepareGoalRecoveryAuthority!;
      vi.spyOn(fixture.runtime.recovery, "prepareGoalRecoveryAuthority").mockImplementation(
        async (...args) => {
          const prepared = await prepare(...args);
          if (mode === "late role revoke") {
            await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
          } else {
            await replaceSessionEntry(target, {
              ...loadSessionEntry(target)!,
              ...(mode === "late lifecycle change"
                ? { lifecycleRevision: "replaced-revision" }
                : { goal: { ...goal, status: "complete" } }),
            });
          }
          return prepared;
        },
      );
    }
    let effects = 0;
    const enteredAttempt = createDeferredCore();
    const releaseAttempt = createDeferredCore();
    let mutationAwaitReached = false;
    if (mode === "mutation await role revoke" || mode === "committed mutation await role revoke") {
      const prepare = pendingStore.preparePendingInputStore;
      vi.spyOn(pendingStore, "preparePendingInputStore").mockImplementation(async (...args) => {
        const store = await prepare(...args);
        return {
          ...store,
          async mutate(input, ...rest) {
            if (input.kind === "recover-accepted" || input.kind === "recover-committed") {
              mutationAwaitReached = true;
              await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
            }
            return store.mutate(input, ...rest);
          },
        };
      });
    }
    vi.spyOn(attempts, "runAgentAttempt").mockImplementation(async (params) => {
      const admitted = await params.preparedRunAdmission.admit("embedded");
      const authority = readAdmittedRunOperatorAuthority(admitted)!;
      authority.assertCurrent();
      expect(authority.profileId).toBe(fixture.profile.id);
      expect(params.sessionId).toBe(sessionId);
      expect(params.runId).toBe(runId);
      expect(loadSessionEntry(target)?.goal).toEqual(goal);
      expect(
        (await getSessionRepositoryWorkspaceStore().get(repository.workspaceId))?.requestedRef,
      ).toBe("clawson/impacted-validation-phase-0");
      expect(
        (await readIssuerFixtureHistory(target, sessionId)).filter(
          (message) => isRecord(message) && message.idempotencyKey === `${runId}:user`,
        ),
      ).toEqual([expect.objectContaining({ content: text, role: "user" })]);
      effects += 1;
      enteredAttempt.resolve();
      await releaseAttempt.promise;
      return {
        payloads: [{ text: "Recovered accepted input" }],
        meta: {
          durationMs: 0,
          agentMeta: {
            sessionId,
            provider: "fixture",
            model: "allowed",
            usage: { input: 0, output: 0, total: 0 },
          },
          stopReason: "stop",
        },
      };
    });
    await refreshPreparedModelRuntimeSnapshots(fixture.cfg, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const respond = vi.fn();
    const recover = async () =>
      await sessionRecoverHandlers["sessions.recover"]!({
        params: { key: sessionKey, agentId: "main" },
        req: { type: "req", id: "recover", method: "sessions.recover" },
        client: fixture.client,
        context: fixture.context,
        respond,
        hasCurrentClientAuthority: fixture.deviceSource.isCurrent,
        isWebchatConnect: () => true,
      });
    try {
      if (mode === "recover" || mode === "committed shutdown") {
        await recover();
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            sessionId,
            key: sessionKey,
            continuation: { status: "started", runId },
          }),
          undefined,
        );
        await enteredAttempt.promise;
        await recover().catch(() => {});
        expect(effects).toBe(1);
        releaseAttempt.resolve();
        await fixture.runtime.recovery.waitForAgent({ runId, timeoutMs: 10_000 });
        await fixture.work.runWhenIdle(() => {});
        expect(
          effects,
          JSON.stringify({
            status: loadSessionEntry(target)?.status,
            error: loadSessionEntry(target)?.lastRunError,
            attemptCalls: vi.mocked(attempts.runAgentAttempt).mock.calls.length,
          }),
        ).toBe(1);
        expect(loadSessionEntry(target)?.goal).toEqual(goal);
        expect(loadSessionEntry(target)?.repositoryWorkspaceId).toBe(repository.workspaceId);
        if (mode === "recover") {
          expect(
            (await readSessionPendingInputStage(scope, "accepted-follower:user", () => {}))
              .existing,
          ).toMatchObject({ state: "interrupted", consumed_event_id: null });
        }
        if (committedMode) {
          expect(
            (await readSessionPendingInputStage(scope, "older-pending-run:user", () => {}))
              .existing,
          ).toMatchObject({
            state: "interrupted",
            consumed_event_id: null,
            run_id: "older-pending-run",
          });
        }
        const events = await loadTranscriptEvents(scope);
        expect(
          events.filter(
            (event) => isRecord(event) && event.customType === "restart-recovery-unresolved-input",
          ),
        ).toEqual([
          expect.objectContaining({ data: { intent: predecessor, disposition: "unresolved" } }),
        ]);
        await recover().catch(() => {});
        await fixture.work.runWhenIdle(() => {});
        expect(effects).toBe(1);
      } else {
        const reason =
          mode === "cancelled"
            ? /No unconsumed accepted input/
            : mode === "effect" ||
                mode === "committed effect" ||
                mode === "committed predecessor effect" ||
                mode === "committed cross-turn result"
              ? /external action.*no verified outcome/
              : mode === "opaque capacity"
                ? /unverified provider capacity wait/
                : mode === "live owner"
                  ? /active work/
                  : mode === "foreign issuer"
                    ? /original authenticated issuer/
                    : mode === "late role revoke" || mode === "mutation await role revoke"
                      ? /Gateway access is not active/
                      : mode === "committed foreign issuer"
                        ? /Original Factory actor profile binding changed/
                        : mode === "committed untrusted sender" ||
                            mode === "committed newer pending"
                          ? /provenance/
                          : mode === "committed mutation await role revoke"
                            ? /Your operator role changed/
                            : /Session changed/;
        await expect(recover()).rejects.toThrow(reason);
        if (
          mode === "mutation await role revoke" ||
          mode === "committed mutation await role revoke"
        ) {
          expect(mutationAwaitReached).toBe(true);
        }
        await fixture.work.runWhenIdle(() => {});
        expect(effects).toBe(0);
        expect(loadSessionEntry(target)?.mainRestartRecovery?.turnIntent).toEqual(predecessor);
        expect(
          (await loadTranscriptEvents(scope)).filter(
            (event) => isRecord(event) && event.customType === "restart-recovery-unresolved-input",
          ),
        ).toEqual([]);
        if (!committedMode) {
          expect(
            (await readSessionPendingInputStage(scope, `${runId}:user`, () => {})).existing
              ?.consumed_event_id,
          ).toBeNull();
        }
      }
    } finally {
      releaseAttempt.resolve();
      lease?.release();
      await fixture.work.runWhenIdle(() => {});
      fixture.original!.release();
      fixture.deviceSource.release();
      fixture.runtime.close();
    }
  });
});
