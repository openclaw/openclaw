import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as lifecycleReads from "../../config/sessions/lifecycle-read.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { getReplyOperationSessionReader } from "../../sessions/session-controller.session-reader.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { admitReplyTurn, runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

export function telegramTurn(sessionKey: string, body: string, from: string) {
  return {
    Body: body,
    RawBody: body,
    CommandBody: body,
    From: from,
    To: "bot",
    ChatType: "direct",
    SessionKey: sessionKey,
    Provider: "telegram",
    Surface: "telegram",
  };
}

type Scope = { agentId: string; storePath: string; sessionKey: string };

async function admit(scope: Scope, sessionId: string, resetTriggered: boolean) {
  const admitted = await admitReplyTurn({ ...scope, sessionId, kind: "visible", resetTriggered });
  if (admitted.status !== "owned" || !admitted.databaseClaim) {
    throw new Error("Fixture requires a retained reply admission");
  }
  const controller = getSessionControllerEntryForOperation(admitted.operation);
  return {
    ...admitted,
    controller,
    databaseClaim: admitted.databaseClaim,
    async [Symbol.asyncDispose]() {
      admitted.operation.complete();
      await waitForReplyRunSuccessorAdmission(scope.sessionKey, null, {
        target: controller.target,
      });
    },
  };
}

function initialize(
  scope: Scope,
  admitted: Awaited<ReturnType<typeof admit>>,
  body: string,
  reset?: { mode: "idle"; idleMinutes: number },
) {
  return runWithReplyOperationLifecycleAdmission(admitted.operation, () =>
    initSessionState({
      cfg: { session: { store: scope.storePath, ...(reset ? { reset } : {}) } },
      ctx: telegramTurn(scope.sessionKey, body, "initialization-user"),
      replyOperation: admitted.operation,
    }),
  );
}

export function registerSessionInitializationAdmissionTests({
  makeStorePath,
}: {
  makeStorePath: (prefix: string, agentId?: string) => Promise<string>;
}) {
  const makeScope = async (name: string, sessionKey = `agent:main:${name}`) => ({
    agentId: "main",
    storePath: await makeStorePath(`openclaw-${name}-`, "main"),
    sessionKey,
  });
  const seed = (scope: Scope, sessionId: string, lifecycleRevision: string) =>
    upsertSessionEntryCore(scope, {
      sessionId,
      lifecycleRevision,
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
    });
  it.each(["same-id", "new-id", "created", "reset-before-read"] as const)(
    "hands the acknowledged %s initialization to a fresh view of its original admission",
    async (kind) => {
      const sessionKey = kind === "new-id" ? "agent:main:acp:handoff" : "agent:main:handoff";
      const scope = await makeScope("initialization-admission", sessionKey);
      const originalId = "before-initialization";
      if (kind !== "created") {
        await seed(scope, originalId, "before-initialization");
      }
      await using admitted = await admit(scope, originalId, kind !== "created");
      const previousReader = getReplyOperationSessionReader(admitted.operation);
      const initialized = await initialize(scope, admitted, kind === "created" ? "hello" : "/new");
      expect(initialized.sessionEntry.lifecycleRevision).not.toBe("before-initialization");
      expect(initialized.sessionId === originalId).toBe(
        kind === "same-id" || kind === "reset-before-read",
      );
      expect(admitted.databaseClaim.isCurrent()).toBe(false);
      if (previousReader) {
        await expect(
          previousReader.withRead(
            { sessionKeys: [sessionKey] },
            () => {},
            () => "obsolete",
          ),
        ).rejects.toThrow("released");
      }
      const reader = getReplyOperationSessionReader(admitted.operation);
      if (!reader) {
        throw new Error("Acknowledged initialization must retain its new reader");
      }
      const read = () =>
        reader.withRead(
          { sessionKeys: [sessionKey] },
          () => {},
          (cohort) => cohort.entries.find((row) => row.sessionKey === sessionKey)?.entry,
        );
      if (kind === "reset-before-read") {
        await upsertSessionEntryCore(scope, {
          ...initialized.sessionEntry,
          lifecycleRevision: "later-reset-after-acknowledgment",
        });
        await expect(read()).rejects.toThrow("Session entry changed during read");
      } else {
        await expect(read()).resolves.toMatchObject({
          sessionId: initialized.sessionId,
          lifecycleRevision: initialized.sessionEntry.lifecycleRevision,
        });
      }
    },
  );
  it.for(["prepared", "retiring"] as const)(
    "joins reply close while the initialization handoff is %s",
    async (stage, { signal }) => {
      const scope = await makeScope("initialization-close");
      const { sessionKey } = scope;
      const sessionId = "initialization-close";
      await seed(scope, sessionId, "before-close");
      await using admitted = await admit(scope, sessionId, true);
      const previous = admitted.databaseClaim;
      if (!("kind" in previous) || !previous.afterTransition) {
        throw new Error("Fixture requires the worker initialization handoff");
      }
      const prepare = previous.afterTransition.bind(previous);
      const prepared = createDeferred<Awaited<ReturnType<typeof prepare>>>();
      const paused = createDeferred();
      const continueHandoff = createDeferred();
      const pause = async (currentStage: typeof stage) => {
        if (stage === currentStage) {
          paused.resolve();
          await continueHandoff.promise;
        }
      };
      const prepareSpy = vi
        .spyOn(previous, "afterTransition")
        .mockImplementation(async (...args) => {
          const next = await prepare(...args);
          prepared.resolve(next);
          await pause("prepared");
          return next;
        });
      const release = previous.release.bind(previous);
      const releaseSpy =
        stage === "retiring"
          ? vi.spyOn(previous, "release").mockImplementation(async () => {
              await release();
              await pause("retiring");
            })
          : undefined;
      let initialization: ReturnType<typeof initSessionState> | undefined;
      let closing: ReturnType<typeof waitForReplyRunSuccessorAdmission> | undefined;
      try {
        initialization = initialize(scope, admitted, "/new");
        void initialization.catch(() => {});
        await withinTest(
          awaitGateBeforeSettlement(
            paused.promise,
            initialization,
            `Initialization settled before its ${stage} handoff`,
          ),
          signal,
        );
        const next = await prepared.promise;
        admitted.operation.complete();
        expect(previous.isCurrent()).toBe(false);
        if (stage === "retiring") {
          expect(next.isCurrent()).toBe(false);
        }
        let closed = false;
        closing = waitForReplyRunSuccessorAdmission(sessionKey, null, {
          target: admitted.controller.target,
        }).then((result) => {
          closed = true;
          return result;
        });
        // One scheduler checkpoint lets the real close run; no elapsed-time delay or polling.
        await yieldImmediate();
        expect(closed).toBe(false);
        continueHandoff.resolve();
        await expect(withinTest(initialization, signal)).rejects.toThrow(
          "Session reader operation is no longer current",
        );
        expect(await withinTest(closing, signal)).toMatchObject({ settled: true });
        expect(next.isCurrent()).toBe(false);
        expect(admitted.controller.active).toBeUndefined();
      } finally {
        continueHandoff.resolve();
        prepareSpy.mockRestore();
        releaseSpy?.mockRestore();
        admitted.operation.complete();
        await Promise.allSettled([initialization, closing]);
      }
    },
  );

  it("recovers initialization start time in its admitted cohort without a second header phase", async () => {
    const scope = await makeScope("initialization-header");
    const { storePath, sessionKey } = scope;
    const sessionId = "initialization-header";
    const startedAt = 1_700_000_000_123;
    await replaceTranscriptEvents({ ...scope, sessionId }, [
      { type: "session", version: 3, id: sessionId, timestamp: new Date(startedAt).toISOString() },
    ]);
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId,
        lifecycleRevision: "header-generation",
        updatedAt: Date.now(),
        lastInteractionAt: Date.now(),
      },
    });
    expect(loadSessionEntry(scope)?.sessionStartedAt).toBeUndefined();
    await using admitted = await admit(scope, sessionId, false);
    const separateHeaderPhase = vi.spyOn(lifecycleReads, "resolveSessionLifecycleTimestampsAsync");
    onTestFinished(() => separateHeaderPhase.mockRestore());
    const initialized = await initialize(scope, admitted, "hello", {
      mode: "idle",
      idleMinutes: 60,
    });
    expect(initialized.isNewSession).toBe(false);
    expect(initialized.sessionEntry).toMatchObject({
      sessionId,
      lifecycleRevision: "header-generation",
      sessionStartedAt: startedAt,
    });
    expect(admitted.databaseClaim.isCurrent()).toBe(true);
    expect(separateHeaderPhase).not.toHaveBeenCalled();
  });
}
