import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as lifecycleReads from "../../config/sessions/lifecycle-read.js";
import {
  loadSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replyRunRegistry, waitForReplyRunSuccessorAdmission } from "./reply-run-registry.js";
import { getReplyOperationSessionReader } from "./reply-run-registry.state.js";
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

export function registerSessionInitializationAdmissionTests({
  makeStorePath,
}: {
  makeStorePath: (prefix: string, agentId?: string) => Promise<string>;
}) {
  it.each(["same-id", "new-id", "created", "reset-before-read"] as const)(
    "hands the acknowledged %s initialization to a fresh view of its original admission",
    async (kind) => {
      const storePath = await makeStorePath("openclaw-initialization-admission-", "main");
      const sessionKey = kind === "new-id" ? "agent:main:acp:handoff" : "agent:main:handoff";
      const scope = { agentId: "main", storePath, sessionKey };
      const originalId = "before-initialization";
      if (kind !== "created") {
        await upsertSessionEntryCore(scope, {
          sessionId: originalId,
          lifecycleRevision: "before-initialization",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        });
      }
      const admitted = await admitReplyTurn({
        ...scope,
        sessionId: originalId,
        kind: "visible",
        resetTriggered: kind !== "created",
      });
      if (admitted.status !== "owned" || !admitted.databaseClaim) {
        throw new Error("Fixture requires a retained reply admission");
      }
      const previousReader = getReplyOperationSessionReader(admitted.operation);
      try {
        const initialized = await runWithReplyOperationLifecycleAdmission(admitted.operation, () =>
          initSessionState({
            cfg: { session: { store: storePath } },
            ctx: telegramTurn(sessionKey, kind === "created" ? "hello" : "/new", "handoff-user"),
            replyOperation: admitted.operation,
          }),
        );
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
      } finally {
        admitted.operation.complete();
        await waitForReplyRunSuccessorAdmission(sessionKey, null);
      }
    },
  );
  it.for(["prepared", "retiring"] as const)(
    "joins reply close while the initialization handoff is %s",
    async (stage, { signal }) => {
      const storePath = await makeStorePath("openclaw-initialization-close-", "main");
      const sessionKey = "agent:main:initialization-close";
      const scope = { agentId: "main", storePath, sessionKey };
      const sessionId = "initialization-close";
      await upsertSessionEntryCore(scope, {
        sessionId,
        lifecycleRevision: "before-close",
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
      });
      const admitted = await admitReplyTurn({
        ...scope,
        sessionId,
        kind: "visible",
        resetTriggered: true,
      });
      if (admitted.status !== "owned" || !admitted.databaseClaim) {
        throw new Error("Fixture requires a retained reply admission");
      }
      const previous = admitted.databaseClaim;
      if (!("kind" in previous) || !previous.afterTransition) {
        admitted.operation.complete();
        await waitForReplyRunSuccessorAdmission(sessionKey, null);
        throw new Error("Fixture requires the worker initialization handoff");
      }
      const prepare = previous.afterTransition.bind(previous);
      const prepared = createDeferred<Awaited<ReturnType<typeof prepare>>>();
      const retired = createDeferred();
      const continueHandoff = createDeferred();
      const prepareSpy = vi
        .spyOn(previous, "afterTransition")
        .mockImplementation(async (...args) => {
          const next = await prepare(...args);
          prepared.resolve(next);
          if (stage === "prepared") {
            await continueHandoff.promise;
          }
          return next;
        });
      const release = previous.release.bind(previous);
      const releaseSpy =
        stage === "retiring"
          ? vi.spyOn(previous, "release").mockImplementation(async () => {
              await release();
              retired.resolve();
              await continueHandoff.promise;
            })
          : undefined;
      let initialization: ReturnType<typeof initSessionState> | undefined;
      let closing: ReturnType<typeof waitForReplyRunSuccessorAdmission> | undefined;
      try {
        initialization = runWithReplyOperationLifecycleAdmission(admitted.operation, () =>
          initSessionState({
            cfg: { session: { store: storePath } },
            ctx: telegramTurn(sessionKey, "/new", "close-user"),
            replyOperation: admitted.operation,
          }),
        );
        void initialization.catch(() => {});
        const next = await withinTest(
          awaitGateBeforeSettlement(
            prepared.promise,
            initialization,
            "Initialization settled before preparing its real successor claim",
          ),
          signal,
        );
        if (stage === "retiring") {
          await withinTest(
            awaitGateBeforeSettlement(
              retired.promise,
              initialization,
              "Initialization settled before its original claim release",
            ),
            signal,
          );
        }
        admitted.operation.complete();
        expect(previous.isCurrent()).toBe(false);
        if (stage === "retiring") {
          expect(next.isCurrent()).toBe(false);
        }
        let closed = false;
        closing = waitForReplyRunSuccessorAdmission(sessionKey, null).then((result) => {
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
        expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      } finally {
        continueHandoff.resolve();
        prepareSpy.mockRestore();
        releaseSpy?.mockRestore();
        admitted.operation.complete();
        await Promise.allSettled([initialization, closing]);
        await waitForReplyRunSuccessorAdmission(sessionKey, null);
      }
    },
  );

  it("recovers initialization start time in its admitted cohort without a second header phase", async () => {
    const storePath = await makeStorePath("openclaw-initialization-header-", "main");
    const sessionKey = "agent:main:initialization-header";
    const sessionId = "initialization-header";
    const scope = { agentId: "main", storePath, sessionKey, sessionId };
    const startedAt = 1_700_000_000_123;
    await replaceTranscriptEvents(scope, [
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
    const admitted = await admitReplyTurn({
      ...scope,
      kind: "visible",
      resetTriggered: false,
    });
    if (admitted.status !== "owned" || !admitted.databaseClaim) {
      throw new Error("Fixture requires a retained reply admission");
    }
    const separateHeaderPhase = vi.spyOn(lifecycleReads, "resolveSessionLifecycleTimestampsAsync");
    try {
      const initialized = await runWithReplyOperationLifecycleAdmission(admitted.operation, () =>
        initSessionState({
          cfg: { session: { store: storePath, reset: { mode: "idle", idleMinutes: 60 } } },
          ctx: telegramTurn(sessionKey, "hello", "header-user"),
          replyOperation: admitted.operation,
        }),
      );
      expect(initialized.isNewSession).toBe(false);
      expect(initialized.sessionEntry).toMatchObject({
        sessionId,
        lifecycleRevision: "header-generation",
        sessionStartedAt: startedAt,
      });
      expect(admitted.databaseClaim.isCurrent()).toBe(true);
      expect(separateHeaderPhase).not.toHaveBeenCalled();
    } finally {
      separateHeaderPhase.mockRestore();
      admitted.operation.complete();
      await waitForReplyRunSuccessorAdmission(sessionKey, null);
    }
  });
}
