import { existsSync } from "node:fs";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as lifecycleReads from "../../config/sessions/lifecycle-read.js";
import {
  loadSessionEntry,
  recordInboundSessionMeta,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.pending-inputs.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  acquireSessionInputActor,
  bindUserTurnInputActor,
} from "../../config/sessions/session-input-actor.js";
import { getSessionTitleLifecycleAsync } from "../../plugin-sdk/session-store-runtime-internal.js";
import {
  releaseSessionControllerClaim,
  retireSessionControllerInput,
  submitSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { getReplyOperationSessionReader } from "../../sessions/session-controller.session-reader.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { prepareReplyAgentTurn } from "./reply-agent-turn-preparation.js";
import { admitReplyTurn, runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import {
  initSessionState,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";
import { createTypingController } from "./typing.js";

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
  assert(admitted.status === "owned" && admitted.databaseClaim, "Expected retained admission");
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
  it("initializes a stable naming lifecycle for an inbound-created Telegram topic", async () => {
    const scope = await makeScope("inbound-topic-lifecycle", "agent:main:main:thread:42001:77");
    const ctx = {
      ...telegramTurn(scope.sessionKey, "Plan home lighting", "telegram:42001"),
      MessageThreadId: "77",
      ThreadLabel: "New Chat",
    };
    const inbound = await recordInboundSessionMeta({ ...scope, ctx });
    assert(inbound, "Inbound metadata must persist the topic before reply initialization");
    expect(inbound.lifecycleRevision).toEqual(expect.any(String));
    const result = await initSessionState({
      ctx,
      cfg: { session: { store: scope.storePath, reset: { mode: "idle", idleMinutes: 999 } } },
    });
    const lifecycle = await getSessionTitleLifecycleAsync(scope);
    expect(lifecycle?.sessionId).toBe(inbound.sessionId);
    expect(lifecycle?.lifecycleRevision).toEqual(expect.any(String));
    expect(lifecycle?.lifecycleRevision).not.toBe("");
    expect(result.sessionEntry.lifecycleRevision).toBe(lifecycle?.lifecycleRevision);
    await initSessionState({
      ctx: { ...ctx, Body: "/model", RawBody: "/model", CommandBody: "/model" },
      cfg: { session: { store: scope.storePath, reset: { mode: "idle", idleMinutes: 999 } } },
    });
    expect(await getSessionTitleLifecycleAsync(scope)).toEqual(lifecycle);
  });
  it.each([
    { name: "newline", trigger: "/steer", command: "/steer\n", resets: true },

    { name: "non-boundary suffix", trigger: "/steer", command: "/steering ", resets: false },

    { name: "no-argument alias with payload", trigger: "/id", command: "/id ", resets: true },
  ])(
    "matches configured reset trigger boundaries with $name",
    async ({ trigger, command, resets }) => {
      const storePath = await makeStorePath("openclaw-configured-reset-boundary-");
      const sessionKey = "agent:main:telegram:dm:reset-boundary";
      const sessionId = "existing-reset-boundary-session";
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId,
          lifecycleRevision: "before",
          updatedAt: Date.now(),
          systemSent: true,
        },
      });
      const previous = loadSessionEntry({ storePath, sessionKey });
      assert(previous, "seeded session");
      const payload = "new task\nkeep this complete instruction";
      const body = `${command}${payload}`;

      const result = await initSessionState({
        ctx: {
          RawBody: body,
          ChatType: "direct",
          SessionKey: sessionKey,
        },
        cfg: { session: { store: storePath, resetTriggers: [trigger] } },
        commandAuthorized: true,
      });

      expect(result.resetTriggered).toBe(resets);
      expect(result.isNewSession).toBe(resets);
      expect(result.sessionId).toBe(sessionId);
      if (resets) {
        expect(result.sessionEntry.lifecycleRevision).not.toBe(previous.lifecycleRevision);
        expect(result.bodyStripped).toBe(payload);
      } else {
        expect(result.sessionEntry.lifecycleRevision).toBe(previous.lifecycleRevision);
        expect(result.bodyStripped).toBeUndefined();
      }
      expect(result.sessionCtx.agentText).toBe(resets ? payload : body);
    },
  );
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
      assert(reader, "Acknowledged initialization must retain its new reader");
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
  it("stages first-turn input through its initialized owner without opening the legacy locator", async () => {
    const scope = await makeScope("initialization-input-custody");
    const text = "Keep this first request before maintenance.";
    const idempotencyKey = "first-turn-input-custody";
    await using admitted = await admit(scope, "initializing-input", false);
    const initialized = await initialize(scope, admitted, text);
    const target = {
      ...scope,
      sessionId: initialized.sessionId,
      sessionEntry: initialized.sessionEntry,
    };
    const recorder = createUserTurnTranscriptRecorder({
      input: { text, idempotencyKey },
      target,
      updateMode: "none",
    });
    // The Gateway recorder predates first-session initialization and has no read source yet.
    let gatewayInput: ReturnType<typeof acquireSessionInputActor> | undefined;
    bindUserTurnInputActor(recorder, {
      phase: "acceptInput",
      acquire: () =>
        (gatewayInput ??= acquireSessionInputActor(
          {
            ...scope,
            target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          },
          { assertCurrent() {}, assertReadable() {} },
        )),
    });
    const queued = createQueueTestRun({ prompt: text, messageId: idempotencyKey });
    const followupRun = {
      ...queued,
      userTurnTranscriptRecorder: recorder,
      run: {
        ...queued.run,
        agentId: scope.agentId,
        sessionId: target.sessionId,
        sessionKey: scope.sessionKey,
        config: { session: { store: scope.storePath } },
      },
    };
    const input = submitSessionControllerInput(
      scope.sessionKey,
      followupRun,
      { mode: "followup" },
      {
        protocolRunId: idempotencyKey,
        storePath: scope.storePath,
      },
    );
    const typing = createTypingController({});
    const checkpoint = new Error("first-turn input reached the maintenance boundary");
    let releaseSourceAdmission: (() => Promise<void>) | undefined;
    try {
      expect(existsSync(scope.storePath)).toBe(false);
      const prepared = await prepareReplyAgentTurn({
        queued: followupRun,
        kind: "visible",
        providedReplyOperation: admitted.operation,
        onOperationOwned: () => true,
        defaults: {
          typing,
          typingMode: "never",
          defaultModel: queued.run.model,
          sessionEntry: target.sessionEntry,
          sessionStore: initialized.sessionStore,
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
          opts: { runId: idempotencyKey },
        },
        signalRunStart: async () => {
          expect(await listSessionPendingInputs(target)).toMatchObject({
            total: 1,
            items: [{ state: "queued", message: { role: "user", content: text, idempotencyKey } }],
          });
          expect(existsSync(scope.storePath)).toBe(false);
          // This existing callback follows source staging and precedes model/memory work.
          throw checkpoint;
        },
      });
      assert(prepared.kind === "admitted", "First-turn preparation must retain its admitted owner");
      releaseSourceAdmission = prepared.turn.releaseSourceAdmission;
      expect(prepared.turn.preflightError).toBe(checkpoint);
      expect(existsSync(scope.storePath)).toBe(false);
    } finally {
      try {
        await releaseSourceAdmission?.();
      } finally {
        admitted.operation.complete();
        try {
          const claim = input.claim;
          if (claim) {
            releaseSessionControllerClaim(claim);
            await claim.settlement.promise;
          } else {
            retireSessionControllerInput(input);
            await input.settlement.promise;
          }
        } finally {
          typing.cleanup();
          await (await gatewayInput?.catch(() => undefined))?.actor.release();
        }
      }
    }
  });

  it.for(["prepared", "retiring"] as const)(
    "joins reply close while the initialization handoff is %s",
    async (stage, { signal }) => {
      const scope = await makeScope("initialization-close");
      const { sessionKey } = scope;
      const sessionId = "initialization-close";
      await seed(scope, sessionId, "before-close");
      await using admitted = await admit(scope, sessionId, true);
      const previous = admitted.databaseClaim;
      assert(
        "kind" in previous && typeof previous.afterTransition === "function",
        "Expected initialization handoff",
      );
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
