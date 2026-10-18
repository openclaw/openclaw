import { existsSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { assert, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createRecoveryRuntimeFixture } from "../../agents/main-session-recovery/main-session-recovery-runtime.test-support.js";
import { recoverStore } from "../../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../../agents/main-session-recovery/main-session-restart-recovery.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { captureRuntimeConfigAsyncReader, setRuntimeConfigSnapshot } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway } from "../../gateway/call.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { resolveSessionMutationAuthorizationAsync } from "../../gateway/session-sharing-authorization-async.js";
import { sharingPolicyClient } from "../../gateway/session-sharing.test-utils.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  createReplyOperation,
  type ReplyOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import { captureSessionControllerSettlement } from "../../sessions/session-controller.lifecycle.js";
import * as controllerMailbox from "../../sessions/session-controller.mailbox.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { scheduleFollowupDrain, type FollowupRun } from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import * as turnAdmission from "./reply-turn-admission.js";
import * as sessionEntryHandle from "./session-entry-handle.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";

type AdmissionFixture = {
  createMinimalRun: (params?: {
    opts?: InternalGetReplyOptions;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    resolvedQueueMode?: string;
    runOverrides?: Partial<FollowupRun["run"]>;
    isActive?: boolean;
    shouldSteer?: boolean;
    sessionCtx?: Partial<TemplateContext>;
  }) => {
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
    followupRun: FollowupRun;
    sourceTurnId?: string;
  };
  makeSessionFixture: (
    overrides?: Partial<SessionEntry>,
    sessionKey?: string,
  ) => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
  }>;
  runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce">;
  queueEmbeddedAgentMessageMock: Pick<Mock, "mock">;
};

function observePredecessorWait() {
  const entered = createDeferred();
  const claimInput = controllerMailbox.claimSessionControllerInput;
  const spy = vi
    .spyOn(controllerMailbox, "claimSessionControllerInput")
    .mockImplementation((source) => {
      const pending = claimInput(source);
      expect(source.controllerInput?.phase).toBe("waiting");
      entered.resolve();
      return pending;
    });
  return {
    async wait(pending: Promise<unknown>) {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Reply finished without waiting for its predecessor");
        }),
      ]);
    },
    restore: () => spy.mockRestore(),
  };
}

export function registerReplyAdmissionCases({
  createMinimalRun,
  makeSessionFixture,
  runEmbeddedAgentMock,
  queueEmbeddedAgentMessageMock,
}: AdmissionFixture): void {
  it.each(["before cleanup", "after cleanup"] as const)(
    "retains a backend drain abort for startup recovery when lifecycle persists %s",
    async (order) => {
      const suffix = order === "before cleanup" ? "before" : "after";
      const sessionKey = `agent:main:dashboard:backend-drain-${suffix}`;
      const sessionId = `backend-drain-session-${suffix}`;
      const runId = `backend-drain-run-${suffix}`;
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const { sessionEntry, sessionStore, storePath } = await makeSessionFixture(
        {
          sessionId,
          restartRecoveryDeliveryRunId: runId,
          restartRecoveryDeliverySourceRunId: runId,
          restartRecoverySourceIngress: "control-ui",
          delivery: { kind: "internal" },
        },
        sessionKey,
      );
      const config = { session: { store: storePath } };
      setRuntimeConfigSnapshot(config, config);
      const scope = { sessionKey, storePath };
      await appendTranscriptMessage(
        { ...scope, sessionId: sessionEntry.sessionId },
        {
          cwd: "/tmp",
          message: {
            role: "user",
            content: "Finish the synthetic task",
            timestamp: 1,
            idempotencyKey: runId,
          },
        },
      );
      const error = createAgentRunRestartAbortError();
      const persistAbort = () =>
        persistGatewaySessionLifecycleEvent({
          ...scope,
          event: {
            runId,
            sessionId: sessionEntry.sessionId,
            lifecycleGeneration,
            ts: Date.now(),
            data: { phase: "error", error, aborted: true, stopReason: "restart" },
          },
        });
      runEmbeddedAgentMock.mockImplementationOnce(async () => {
        await persistGatewaySessionLifecycleEvent({
          ...scope,
          event: {
            runId,
            sessionId: sessionEntry.sessionId,
            lifecycleGeneration,
            ts: Date.now(),
            data: { phase: "start", startedAt: Date.now() },
          },
        });
        expect(loadSessionEntry(scope)?.lifecycleRunId).toBe(runId);
        if (order === "before cleanup") {
          await persistAbort();
        }
        // The drain cancels the backend owner, without aborting the caller signal.
        throw error;
      });
      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        opts: { runId },
        sessionCtx: { Provider: "webchat", MessageSid: runId },
        runOverrides: { config, sessionId },
      });
      const reply = await run();
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(reply).toEqual({});
      if (order === "after cleanup") {
        await persistAbort();
      }
      const interrupted = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(interrupted).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: runId,
      });
      expect(interrupted?.restartRecoveryTerminalRunIds ?? []).not.toContain(runId);
      rotateAgentEventLifecycleGeneration();
      await markStartupOrphanedMainSessionsForRecovery({ cfg: { session: { store: storePath } } });
      const dispatch = vi.fn<typeof callGateway>();
      dispatch.mockResolvedValue({ runId: "resumed-backend-drain" });
      const settlement = createDeferred();
      const gatewayRuntime = createRecoveryRuntimeFixture({
        callGateway: dispatch,
        getDispatchSettlement: () => settlement.promise,
        sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
      });
      try {
        expect(
          await recoverStore({ storePath, gatewayRuntime, handledSessionKeys: new Set() }),
        ).toMatchObject({ started: 1, failed: 0 });
        expect(
          await recoverStore({ storePath, gatewayRuntime, handledSessionKeys: new Set() }),
        ).toMatchObject({ started: 0, failed: 0 });
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        settlement.resolve();
      }
    },
  );

  it("tombstones a redelivered source whose recovery claim is already terminal", async () => {
    const sessionCtx = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:24680",
      MessageSid: "redelivered-terminal-message",
    } as const;
    const sourceTurnId = expectDefined(
      buildChannelSourceTurnId({
        provider: "discord",
        conversationId: "channel:24680",
        messageId: "redelivered-terminal-message",
      }),
      "terminal redelivery source identity",
    );
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
      status: "done",
      restartRecoveryDeliveryRunId: "terminal-recovery-run",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      restartRecoveryDeliveryContext: {
        channel: "discord",
        to: "channel:24680",
      },
    });
    const onAdopted = vi.fn();
    const duplicate = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      opts: { turnAdoptionLifecycle: { onAdopted } },
      sessionCtx,
      runOverrides: { messageProvider: "discord" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    const cfg: OpenClawConfig = { session: { store: storePath } };
    const profileId = "retirement-operator";
    const scopes = ["operator.admin"];
    const authorized = await resolveSessionMutationAuthorizationAsync({
      client: sharingPolicyClient({ user: profileId, scopes }),
      context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
      method: "sessions.patch",
      requestParams: { key: "main" },
      expectedTarget: {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: sessionEntry.sessionId,
        storePath,
      },
    });
    expect(authorized.error).toBeNull();
    const authority = expectDefined(
      authorized.authorization,
      "session-backed retirement authority",
    );
    onTestFinished(() => authority.release?.());
    duplicate.followupRun.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId,
      scopes,
      assertCurrent: authority.assertCurrent,
    });

    await expect(duplicate.run()).resolves.toBeUndefined();

    expect(duplicate.sourceTurnId).toBe(sourceTurnId);
    expect(onAdopted).not.toHaveBeenCalled();
    expect(queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    const stored = expectDefined(
      loadSessionEntry({ storePath, sessionKey: "main", readConsistency: "latest" }),
      "stored terminal session",
    );
    expect(stored).toMatchObject({
      status: "done",
      restartRecoveryTerminalRunIds: [sourceTurnId],
    });
    expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(stored.restartRecoveryDeliverySourceRunId).toBeUndefined();
  });

  it.each(["backend", "adoption"] as const)(
    "settles a tracked reply after lifecycle rotation during %s completion",
    async (stage) => {
      const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
        status: undefined,
        restartRecoveryDeliveryRunId: "msg",
      });
      let operation: ReplyOperation | undefined;
      const retire = () => {
        expect(loadSessionEntry({ agentId: "main", storePath, sessionKey: "main" })).toMatchObject({
          restartRecoveryDeliveryRunId: "msg",
        });
        operation = getSessionControllerOperation("main");
        expect(operation).toBeDefined();
        rotateAgentEventLifecycleGeneration();
        expect(operation?.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
      };
      if (stage === "backend") {
        runEmbeddedAgentMock.mockImplementationOnce(async () => {
          retire();
          return { payloads: [{ text: "retired backend output" }], meta: {} };
        });
      }
      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        storePath,
        opts:
          stage === "adoption"
            ? {
                turnAdoptionLifecycle: {
                  onAdopted: async () => {
                    retire();
                    throw new Error("Adoption notification stopped during restart");
                  },
                },
              }
            : undefined,
      });
      try {
        await expect(run()).resolves.toEqual(
          stage === "backend"
            ? {}
            : {
                text: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
              },
        );
        expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(stage === "backend" ? 1 : 0);
        expect(scheduleFollowupDrain).toHaveBeenCalledOnce();
        expect(loadSessionEntry({ agentId: "main", storePath, sessionKey: "main" })).toMatchObject({
          restartRecoveryDeliveryRunId: "msg",
        });
      } finally {
        operation?.complete();
      }
    },
  );

  it("runs visible turns with the session id returned by admission", async () => {
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "pre-compact-session",
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");
    const sessionStore: Record<string, SessionEntry> = {
      main: { sessionId: "pre-compact-session", updatedAt: 1 },
    };
    const { run } = createMinimalRun({
      runOverrides: { sessionId: "stale-session" },
      sessionStore,
    });
    runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
      expect(params).toMatchObject({ sessionId: "post-compact-session", sessionFile: "main" });
      expect(sessionStore.main).toMatchObject({ sessionId: "post-compact-session" });
      return { payloads: [{ text: "final" }], meta: {} };
    });
    const waiting = observePredecessorWait();
    const pending = run();
    try {
      await waiting.wait(pending);
      active.updateSessionId("post-compact-session");
      sessionStore.main = {
        sessionId: "post-compact-session",
        updatedAt: 2,
      };
      active.complete();
      await expect(pending).resolves.toMatchObject({ text: "final" });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    } finally {
      active.complete();
      await Promise.allSettled([pending]);
      waiting.restore();
    }
  });

  it.each([
    { storage: "durable", orphanedRecovery: false, owedRecovery: false, queueMode: "interrupt" },
    { storage: "durable", orphanedRecovery: true, owedRecovery: false, queueMode: "interrupt" },
    { storage: "incognito", orphanedRecovery: false, owedRecovery: false, queueMode: "interrupt" },
    { storage: "durable", orphanedRecovery: false, owedRecovery: true, queueMode: "followup" },
    { storage: "durable", orphanedRecovery: false, owedRecovery: true, queueMode: "interrupt" },
  ])(
    "publishes the admitted rotation without rereading it ($storage, orphaned recovery=$orphanedRecovery, owed recovery=$owedRecovery, $queueMode)",
    async ({ storage, orphanedRecovery, owedRecovery, queueMode }) => {
      // An ordinary input claims the owed resend; an interrupt retires it (never replayed or charged).
      const claimedRecovery = owedRecovery && queueMode !== "interrupt";
      const interruptedRecovery = owedRecovery && queueMode === "interrupt";
      const sessionKey = "agent:main:main";
      const initial = {
        sessionId: "pre-compact-session",
        verboseLevel: "off",
        responseUsage: "off" as const,
      };
      const fixture: Awaited<ReturnType<AdmissionFixture["makeSessionFixture"]>> =
        storage === "incognito"
          ? await (async () => {
              const state = await createOpenClawTestState({ label: "reply-admission-incognito" });
              onTestFinished(() => state.cleanup());
              await captureRuntimeConfigAsyncReader()();
              const storePath = resolveIncognitoOpenClawAgentSqlitePath({
                agentId: "main",
                env: state.env,
              });
              const sessionEntry: SessionEntry = {
                ...initial,
                incognito: true,
                updatedAt: Date.now(),
              };
              await replaceSessionEntry({ sessionKey, storePath, env: state.env }, sessionEntry);
              return { sessionEntry, sessionStore: { [sessionKey]: sessionEntry }, storePath };
            })()
          : await makeSessionFixture(initial, sessionKey);
      const { sessionEntry, sessionStore, storePath } = fixture;
      const scope = { storePath, sessionKey };
      const predecessor = await turnAdmission.admitReplyTurn({
        ...scope,
        sessionId: sessionEntry.sessionId,
        kind: "visible",
        resetTriggered: false,
      });
      assert(predecessor.status === "owned");
      const active = predecessor.operation;
      active.setPhase("preflight_compacting");
      const expected = {
        sessionId: "post-compact-session",
        verboseLevel: "on",
        responseUsage: "full" as const,
      };
      const replacement: SessionEntry = {
        ...sessionEntry,
        ...expected,
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        updatedAt: sessionEntry.updatedAt + 1,
        ...(orphanedRecovery
          ? {
              status: undefined,
              abortedLastRun: false,
              restartRecoveryRuns: [{ runId: "terminal-run", lifecycleGeneration: "retired" }],
              restartRecoveryTerminalRunIds: ["terminal-run"],
            }
          : {}),
        ...(owedRecovery
          ? {
              status: undefined,
              abortedLastRun: true,
              mainRestartRecovery: { cycleId: "admitted-cycle", revision: 1, chargedAttempts: 0 },
            }
          : {}),
      };
      const settleClaimedFixture = async () => {
        if (!claimedRecovery) {
          return;
        }
        // The mock backend must settle its synthetic interruption before releasing foreground custody.
        await updateSessionEntry(scope, (current) =>
          current.sessionId === expected.sessionId
            ? { status: "done", abortedLastRun: false }
            : null,
        );
      };
      const assertPublished = () => {
        const published = sessionStore[sessionKey];
        assert(published);
        expect(published).toMatchObject(expected);
        expect(published.restartRecoveryRuns).toBeUndefined();
        if (claimedRecovery) {
          assert(admittedOperation);
          expect(published).toMatchObject({
            abortedLastRun: true,
            mainRestartRecovery: {
              cycleId: "admitted-cycle",
              chargedAttempts: 0,
              foregroundClaims: {
                lifecycleGeneration: admittedOperation.lifecycleGeneration,
                tokens: [expect.any(String)],
              },
            },
          });
        } else {
          expect(published.mainRestartRecovery).toBeUndefined();
        }
        if (interruptedRecovery) {
          expect(published).toMatchObject({ abortedLastRun: false, status: "killed" });
        }
      };
      let observer: ReturnType<typeof observeMainThreadSql> | undefined;
      const restoreObserver = () => {
        observer?.restore();
        observer = undefined;
      };
      let admittedOperation: ReplyOperation | undefined;
      let restorePublication: (() => void) | undefined;
      let handoffChecked = false;
      let sqlFailure: unknown;
      const admit = turnAdmission.admitReplyTurn;
      const admission = vi
        .spyOn(turnAdmission, "admitReplyTurn")
        .mockImplementation(async (params) => {
          const result = await admit(params);
          if (result.status === "owned") {
            admittedOperation = result.operation;
            const createHandle = sessionEntryHandle.createReplySessionEntryHandle;
            const publication = vi
              .spyOn(sessionEntryHandle, "createReplySessionEntryHandle")
              .mockImplementation((handleParams) => {
                const handle = createHandle(handleParams);
                try {
                  // Observe admission through its actual publication, before unrelated preflight.
                  assertPublished();
                  assert(observer);
                  try {
                    observer.expectIdle();
                  } catch (error) {
                    sqlFailure = error;
                  }
                  handoffChecked = true;
                } finally {
                  restoreObserver();
                  publication.mockRestore();
                }
                return handle;
              });
            restorePublication = () => publication.mockRestore();
            observer = observeMainThreadSql();
          }
          return result;
        });
      runEmbeddedAgentMock.mockImplementationOnce(async (params) => {
        expect(params).toMatchObject({ sessionId: expected.sessionId, sessionFile: sessionKey });
        const stored = loadSessionEntry({ ...scope, readConsistency: "latest" });
        const published = sessionStore[sessionKey];
        assert(published);
        expect(stored).toMatchObject(expected);
        expect(published).toMatchObject(expected);
        expect(published.restartRecoveryRuns).toEqual(stored?.restartRecoveryRuns);
        expect(published.mainRestartRecovery).toEqual(stored?.mainRestartRecovery);
        if (!claimedRecovery) {
          assertPublished();
        }
        await settleClaimedFixture();
        if (storage === "incognito") {
          expect(existsSync(storePath)).toBe(false);
        }
        return { payloads: [{ text: "final" }], meta: {} };
      });
      const waiting = observePredecessorWait();
      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        resolvedQueueMode: queueMode,
        runOverrides: { sessionId: sessionEntry.sessionId },
      });
      const pending = run();
      try {
        await waiting.wait(pending);
        await turnAdmission.runWithReplyOperationLifecycleAdmission(active, () =>
          replaceSessionEntry(scope, replacement),
        );
        active.updateSessionId(expected.sessionId);
        active.complete();
        await pending;
        expect(handoffChecked).toBe(true);
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        if (sqlFailure !== undefined) {
          assert(sqlFailure instanceof Error);
          throw sqlFailure;
        }
      } finally {
        // The fixture owns admission and observer cleanup even when a handoff assertion fails.
        restoreObserver();
        active.complete();
        await Promise.allSettled([pending]);
        restoreObserver();
        try {
          await settleClaimedFixture();
        } finally {
          const released = captureSessionControllerSettlement({
            scope: storePath,
            identities: [sessionKey],
          });
          admittedOperation?.complete();
          await released;
          restorePublication?.();
          admission.mockRestore();
          waiting.restore();
        }
      }
    },
  );

  it("does not publish a rotated fallback when the waiting caller is aborted", async () => {
    const sessionKey = "agent:main:main";
    const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({}, sessionKey);
    const scope = { storePath, sessionKey };
    const predecessor = await turnAdmission.admitReplyTurn({
      ...scope,
      sessionId: sessionEntry.sessionId,
      kind: "visible",
      resetTriggered: false,
    });
    assert(predecessor.status === "owned");
    const active = predecessor.operation;
    active.setPhase("preflight_compacting");
    const controller = new AbortController();
    const receipt: ReplyOperationRunState = {};
    const waiting = observePredecessorWait();
    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      opts: { abortSignal: controller.signal, [REPLY_OPERATION_RUN_STATE]: receipt },
    });
    const pending = run();
    try {
      await waiting.wait(pending);
      await turnAdmission.runWithReplyOperationLifecycleAdmission(active, () =>
        replaceSessionEntry(scope, { ...sessionEntry, sessionId: "cancelled-rotation" }),
      );
      active.updateSessionId("cancelled-rotation");
      controller.abort();
      active.complete();
      await expect(pending).resolves.toBeUndefined();
      expect(receipt.admission).toEqual({ status: "skipped", reason: "aborted" });
      expect(sessionStore[sessionKey]).toBe(sessionEntry);
      expect(sessionEntry.sessionId).toBe("session");
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      active.complete();
      await Promise.allSettled([pending]);
      waiting.restore();
    }
  });
}
