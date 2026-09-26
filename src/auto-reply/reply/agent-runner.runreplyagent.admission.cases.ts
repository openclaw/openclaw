import { existsSync } from "node:fs";
import { assert, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { scheduleFollowupDrain, type FollowupRun } from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import {
  createReplyOperation,
  replyRunRegistry,
  type ReplyOperation,
} from "./reply-run-registry.js";
import * as turnAdmission from "./reply-turn-admission.js";

type AdmissionFixture = {
  createMinimalRun: (params?: {
    opts?: InternalGetReplyOptions;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    runOverrides?: Partial<FollowupRun["run"]>;
  }) => { run: () => Promise<ReplyPayload | ReplyPayload[] | undefined> };
  makeSessionFixture: (
    overrides?: Partial<SessionEntry>,
    sessionKey?: string,
  ) => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
  }>;
  runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce">;
};

function observePredecessorWait() {
  const entered = createDeferred();
  const waitForIdle = replyRunRegistry.waitForIdle.bind(replyRunRegistry);
  const spy = vi.spyOn(replyRunRegistry, "waitForIdle").mockImplementation((...args) => {
    const pending = waitForIdle(...args);
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
}: AdmissionFixture): void {
  it.each(["backend", "adoption"] as const)(
    "settles a tracked reply after lifecycle rotation during %s completion",
    async (stage) => {
      const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
        status: "running",
        restartRecoveryDeliveryRunId: "msg",
      });
      let operation: ReplyOperation | undefined;
      const retire = () => {
        expect(loadSessionEntry({ storePath, sessionKey: "main" })).toMatchObject({
          restartRecoveryDeliveryRunId: "msg",
        });
        operation = replyRunRegistry.get("main");
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
        await expect(run()).resolves.toMatchObject({
          text:
            stage === "backend"
              ? SILENT_REPLY_TOKEN
              : "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
        });
        expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(stage === "backend" ? 1 : 0);
        expect(scheduleFollowupDrain).toHaveBeenCalledOnce();
        expect(loadSessionEntry({ storePath, sessionKey: "main" })).toMatchObject({
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
      await pending;
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    } finally {
      active.complete();
      await Promise.allSettled([pending]);
      waiting.restore();
    }
  });

  it.each([
    { storage: "durable", orphanedRecovery: false, claimedRecovery: false },
    { storage: "durable", orphanedRecovery: true, claimedRecovery: false },
    { storage: "incognito", orphanedRecovery: false, claimedRecovery: false },
    { storage: "durable", orphanedRecovery: false, claimedRecovery: true },
  ])(
    "publishes the admitted rotation without rereading it ($storage, orphaned recovery=$orphanedRecovery, claimed recovery=$claimedRecovery)",
    async ({ storage, orphanedRecovery, claimedRecovery }) => {
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
        updatedAt: sessionEntry.updatedAt + 1,
        ...(orphanedRecovery
          ? {
              status: "running" as const,
              abortedLastRun: false,
              restartRecoveryRuns: [{ runId: "orphaned-run", lifecycleGeneration: "retired" }],
            }
          : {}),
        ...(claimedRecovery
          ? {
              status: "running" as const,
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
      };
      let observer: ReturnType<typeof observeMainThreadSql> | undefined;
      const restoreObserver = () => {
        observer?.restore();
        observer = undefined;
      };
      let admittedOperation: ReplyOperation | undefined;
      let restoreBinding: (() => void) | undefined;
      let handoffChecked = false;
      let sqlFailure: unknown;
      const admit = turnAdmission.admitReplyTurn;
      const admission = vi
        .spyOn(turnAdmission, "admitReplyTurn")
        .mockImplementation(async (params) => {
          const result = await admit(params);
          if (result.status === "owned") {
            admittedOperation = result.operation;
            const bind = result.operation.bindToolAuthoritySnapshot.bind(result.operation);
            const binding = vi
              .spyOn(result.operation, "bindToolAuthoritySnapshot")
              .mockImplementation((snapshot) => {
                try {
                  // Stop before unrelated runtime preparation; publication must already be complete.
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
                }
                return bind(snapshot);
              });
            restoreBinding = () => binding.mockRestore();
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
        // A handoff assertion precedes the runner's try/finally, so this fixture owns cleanup too.
        restoreObserver();
        active.complete();
        await Promise.allSettled([pending]);
        restoreObserver();
        try {
          await settleClaimedFixture();
        } finally {
          const released = getSessionWorkAdmissionRelease({
            scope: storePath,
            identities: [sessionKey],
          });
          admittedOperation?.complete();
          await released;
          restoreBinding?.();
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
