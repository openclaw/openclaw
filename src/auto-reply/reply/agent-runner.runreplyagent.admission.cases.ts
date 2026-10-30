import { existsSync } from "node:fs";
import { assert, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
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
}: AdmissionFixture): void {
  it.each(["backend", "adoption"] as const)(
    "settles a tracked reply after lifecycle rotation during %s completion",
    async (stage) => {
      const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
        status: undefined,
      });
      let operation: ReplyOperation | undefined;
      const retire = () => {
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
        await expect(run()).resolves.toEqual({});
        expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(stage === "backend" ? 1 : 0);
        expect(scheduleFollowupDrain).toHaveBeenCalledOnce();
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

  it.each(["durable", "incognito"] as const)(
    "publishes the admitted rotation without rereading it (%s)",
    async (storage) => {
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
      };
      const assertPublished = () => {
        const published = sessionStore[sessionKey];
        assert(published);
        expect(published).toMatchObject(expected);
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
        assertPublished();
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
        resolvedQueueMode: "interrupt",
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
        {
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
