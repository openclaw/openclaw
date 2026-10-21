import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { registerChatAbortController } from "../../gateway/chat-abort.js";
import { createGatewayTerminalTracking } from "../../gateway/server-runtime-terminal-tracking.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import {
  beginSessionControllerSourceInjection,
  bindSessionControllerSource,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  trackSessionControllerSourceWork,
} from "../../sessions/session-controller.mailbox.js";
import { isRpcSourceRegistered } from "../../sessions/session-controller.rpc-sources.js";
import type { SessionTarget } from "../../sessions/session-controller.target.js";
import { captureChannelSessionStop } from "./abort-operation.js";
import { tryFastAbortFromMessage, type FastAbortRequestParams } from "./abort.js";
import { handleAbortTrigger, handleStopCommand } from "./commands-session-abort.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { enqueueFollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { prepareReplySourceInput } from "./reply-source-binding.js";

type StopAcknowledgmentFixture = FastAbortRequestParams & {
  entry: { sessionId: string };
  params: HandleCommandsParams;
  storePath: string;
  target: SessionTarget;
};

export function registerAbortAcknowledgmentCases({
  sessionKey,
  setupStop,
}: {
  sessionKey: string;
  setupStop: () => Promise<StopAcknowledgmentFixture>;
}) {
  it.for(["fast", "command", "trigger"] as const)(
    "%s Stop acknowledges before raw producer settlement and preserves its successor fence",
    async (pathKind, { signal }) => {
      const state = await setupStop();
      const ready = createDeferred<ReplyOperation>();
      const releaseProducer = createDeferred();
      const cleanupError = new Error("late native source cleanup failed");
      const cancel = vi.fn();
      const admission = {
        agentId: "main",
        sessionKey,
        sessionId: state.entry.sessionId,
        target: state.target,
      };
      let producerReturned = false;
      const producer = withSessionTurn(
        {
          ...admission,
          onSettled: async () => {
            throw cleanupError;
          },
        },
        async (operation) => {
          const current = expectDefined(operation, "native producer operation");
          current.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
          ready.resolve(current);
          await releaseProducer.promise;
          producerReturned = true;
          return "native producer returned";
        },
      );
      void producer.catch(ready.reject);
      const operation = await withinTest(ready.promise, signal);
      const capture = captureChannelSessionStop({
        key: sessionKey,
        sessionId: state.entry.sessionId,
        storePath: state.storePath,
        agentId: "main",
      });
      let settlementFinished = false;
      const settlement = capture.controller.settled.then(
        () => {
          settlementFinished = true;
          return undefined;
        },
        (error: unknown) => {
          settlementFinished = true;
          return error;
        },
      );
      const successorRun = vi.fn(async () => "successor ran");
      let successor: Promise<string> | undefined;
      try {
        const stopping =
          pathKind === "fast"
            ? tryFastAbortFromMessage(state)
            : pathKind === "command"
              ? handleStopCommand(state.params, true)
              : handleAbortTrigger(
                  {
                    ...state.params,
                    command: {
                      ...state.params.command,
                      rawBodyNormalized: "stop",
                      commandBodyNormalized: "stop",
                    },
                  },
                  true,
                );
        expect(await withinTest<Awaited<typeof stopping>>(stopping, signal)).toMatchObject(
          pathKind === "fast"
            ? { handled: true, aborted: true }
            : { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } },
        );
        expect(cancel).toHaveBeenCalledOnce();
        expect(operation.result).toMatchObject({ kind: "aborted", code: "aborted_by_user" });
        expect(loadSessionEntry({ storePath: state.storePath, sessionKey })).toMatchObject({
          sessionId: state.entry.sessionId,
          abortedLastRun: true,
        });
        expect(producerReturned).toBe(false);
        expect(settlementFinished).toBe(false);
        successor = withSessionTurn(admission, successorRun);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(successorRun).not.toHaveBeenCalled();
        releaseProducer.resolve();
        expect(await withinTest(producer, signal)).toBe("native producer returned");
        const error = await withinTest(settlement, signal);
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) {
          throw new Error("Expected the retained source cleanup failure", { cause: error });
        }
        expect(error.message).toBe("Session source cleanup failed");
        expect(error.errors).toEqual([cleanupError]);
        expect(await withinTest(successor, signal)).toBe("successor ran");
        expect(successorRun).toHaveBeenCalledOnce();
      } finally {
        releaseProducer.resolve();
        await Promise.allSettled([producer, settlement, successor]);
      }
    },
  );

  it("acknowledges Stop while unclaimed preparation remains retained and fences its successor", async ({
    signal,
  }) => {
    const state = await setupStop();
    const prepared = prepareReplySourceInput({ ...state.ctx, SessionKey: sessionKey }, state.cfg, {
      expectedExistingSessionId: state.entry.sessionId,
    });
    const input = expectDefined(prepared.input, "preparing channel input");
    const preparation = createDeferred();
    const preparationFailure = new Error("late channel preparation cleanup failed");
    trackSessionControllerSourceWork(input, preparation.promise);
    const capture = captureChannelSessionStop({
      key: sessionKey,
      sessionId: state.entry.sessionId,
      storePath: state.storePath,
      agentId: "main",
    });
    let settlementFinished = false;
    const settlement = capture.controller.settled.then(
      () => {
        settlementFinished = true;
        return undefined;
      },
      (error: unknown) => {
        settlementFinished = true;
        return error;
      },
    );
    const successorRun = vi.fn(async () => "successor ran");
    const stopping = tryFastAbortFromMessage(state);
    let successor: Promise<string> | undefined;
    try {
      expect(await withinTest(stopping, signal)).toMatchObject({ handled: true });
      expect(input.abortSignal.aborted).toBe(true);
      expect(loadSessionEntry({ storePath: state.storePath, sessionKey })).toMatchObject({
        sessionId: state.entry.sessionId,
        abortedLastRun: true,
      });
      expect(settlementFinished).toBe(false);
      successor = withSessionTurn(
        {
          agentId: "main",
          sessionKey,
          sessionId: state.entry.sessionId,
          target: state.target,
        },
        successorRun,
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(successorRun).not.toHaveBeenCalled();
      preparation.reject(preparationFailure);
      const failure = await withinTest(settlement, signal);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected retained preparation failure", { cause: failure });
      }
      expect(failure.errors).toEqual([preparationFailure]);
      expect(await withinTest(successor, signal)).toBe("successor ran");
      expect(successorRun).toHaveBeenCalledOnce();
    } finally {
      preparation.resolve();
      await Promise.allSettled([stopping, settlement, successor]);
    }
  });

  it.for(["injecting", "claimed"] as const)(
    "acknowledges channel Stop after publication when captured preparation becomes %s",
    async (phase, { signal }) => {
      const state = await setupStop();
      const metadataEntered = createDeferred();
      const releaseMetadata = createDeferred();
      const cancellationEntered = createDeferred();
      const publication = createDeferred();
      const cleanupEntered = createDeferred();
      const cleanup = createDeferred();
      const producerStarted = createDeferred();
      const releaseProducer = createDeferred();
      const cancel = vi.fn(() => {
        cancellationEntered.resolve();
      });
      const cancellationAcknowledgment = vi.fn(async () => {
        await publication.promise;
      });
      const input = reserveSessionControllerSource(sessionKey, {
        target: state.target,
        policy: { mode: "followup" },
        adapter: {
          cancel,
          cancellationAcknowledgment,
          onSettled: async () => {
            cleanupEntered.resolve();
            await cleanup.promise;
          },
        },
      });
      const resolveTarget = sessionAccessor.resolveSessionAbortTarget;
      const metadata = vi
        .spyOn(sessionAccessor, "resolveSessionAbortTarget")
        .mockImplementationOnce(async (...args) => {
          metadataEntered.resolve();
          await releaseMetadata.promise;
          return await resolveTarget(...args);
        });
      let acknowledged = false;
      const stopping = tryFastAbortFromMessage(state).then((result) => {
        acknowledged = true;
        return result;
      });
      let injection: ReturnType<typeof beginSessionControllerSourceInjection> | undefined;
      let producer: Promise<void> | undefined;
      const successorRun = vi.fn(async () => "successor ran");
      let successor: Promise<string> | undefined;
      try {
        await withinTest(metadataEntered.promise, signal);
        if (phase === "injecting") {
          injection = beginSessionControllerSourceInjection(input);
          expect(await withinTest(injection.admit(), signal)).toBe(true);
        } else {
          producer = withSessionTurn(
            {
              agentId: "main",
              sessionKey,
              sessionId: state.entry.sessionId,
              target: state.target,
              controllerInput: input,
            },
            async () => {
              producerStarted.resolve();
              await releaseProducer.promise;
            },
          );
          void producer.catch(producerStarted.reject);
          await withinTest(producerStarted.promise, signal);
        }
        releaseMetadata.resolve();
        await withinTest(cancellationEntered.promise, signal);
        expect(input.abortSignal.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledOnce();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(cancellationAcknowledgment).toHaveBeenCalledOnce();
        expect(acknowledged).toBe(false);
        publication.resolve();
        expect(await withinTest(stopping, signal)).toMatchObject({ handled: true, aborted: true });
        expect(loadSessionEntry({ storePath: state.storePath, sessionKey })).toMatchObject({
          sessionId: state.entry.sessionId,
          abortedLastRun: true,
        });
        expect(input.phase).toBe(phase);
        successor = withSessionTurn(
          {
            agentId: "main",
            sessionKey,
            sessionId: state.entry.sessionId,
            target: state.target,
          },
          successorRun,
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(successorRun).not.toHaveBeenCalled();
        injection?.finish(true);
        releaseProducer.resolve();
        if (producer) {
          await withinTest(producer, signal);
        }
        await withinTest(cleanupEntered.promise, signal);
        expect(successorRun).not.toHaveBeenCalled();
        cleanup.resolve();
        await withinTest(input.settlement.promise, signal);
        expect(await withinTest(successor, signal)).toBe("successor ran");
        expect(successorRun).toHaveBeenCalledOnce();
      } finally {
        releaseMetadata.resolve();
        publication.resolve();
        injection?.finish(true);
        releaseProducer.resolve();
        cleanup.resolve();
        retireSessionControllerInput(input);
        await Promise.allSettled([
          stopping,
          input.settlement.promise,
          ...(producer ? [producer] : []),
          ...(successor ? [successor] : []),
        ]);
        metadata.mockRestore();
      }
    },
  );

  it.for([false, true])(
    "waits for queued notification while preserving raw preparation custody: %s",
    async (retainPreparation, { signal }) => {
      const state = await setupStop();
      const notificationEntered = createDeferred();
      const notification = createDeferred();
      const preparation = createDeferred();
      const releaseAuthority = vi.fn();
      const authorityController = new AbortController();
      const onAbandoned = vi.fn(async () => {
        notificationEntered.resolve();
        await notification.promise;
      });
      const onSettled = vi.fn();
      const queued = createQueueTestRun({ prompt: "queued notification" });
      queued.run = {
        ...queued.run,
        agentId: "main",
        sessionKey,
        sessionId: state.entry.sessionId,
        config: state.cfg,
      };
      queued.operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "guest",
        scopes: ["operator.read", "operator.write"],
        source: {},
        signal: authorityController.signal,
        assertCurrent: () => authorityController.signal.throwIfAborted(),
        retain: () => releaseAuthority,
      });
      queued.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned, onSettled };
      enqueueFollowupRun(
        sessionKey,
        queued,
        { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
        "none",
      );
      const input = expectDefined(queued.controllerInput, "queued source");
      if (retainPreparation) {
        trackSessionControllerSourceWork(input, preparation.promise);
      }
      let acknowledged = false;
      const stopping = tryFastAbortFromMessage(state).then((result) => {
        acknowledged = true;
        return result;
      });
      try {
        await withinTest(notificationEntered.promise, signal);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(acknowledged).toBe(false);
        expect(onAbandoned).toHaveBeenCalledOnce();
        expect(releaseAuthority).not.toHaveBeenCalled();
        notification.resolve();
        expect(await withinTest(stopping, signal)).toMatchObject({ handled: true });
        if (retainPreparation) {
          expect(onSettled).not.toHaveBeenCalled();
          expect(releaseAuthority).not.toHaveBeenCalled();
        }
        preparation.resolve();
        await withinTest(input.settlement.promise, signal);
        expect(onAbandoned).toHaveBeenCalledOnce();
        expect(onSettled).toHaveBeenCalledOnce();
        expect(releaseAuthority).toHaveBeenCalledOnce();
      } finally {
        notification.resolve();
        preparation.resolve();
        await Promise.allSettled([stopping, input.settlement.promise]);
      }
    },
  );

  it("joins a Gateway terminal receipt installed by async abandonment while retaining preparation", async ({
    signal,
  }) => {
    const state = await setupStop();
    const runId = "queued-preparation-terminal";
    const preparation = createDeferred();
    const notificationEntered = createDeferred();
    const notification = createDeferred();
    const persistence = createDeferred();
    const publicationEntered = createDeferred();
    const removed = vi.fn();
    const onSettled = vi.fn();
    const registration = registerChatAbortController({
      runId,
      sessionKey,
      sessionId: state.entry.sessionId,
      agentId: "main",
      target: state.target,
      timeoutMs: 60_000,
      sourceWork: preparation.promise,
      onRemoved: removed,
    });
    if (!registration.registered) {
      throw new Error("Expected a new Gateway source registration");
    }
    const entry = registration.entry;
    const tracking = createGatewayTerminalTracking({
      getScopedRpcSource: (id) =>
        id === runId && isRpcSourceRegistered(entry) ? entry : undefined,
      restartRecoveryCandidates: new Map(),
    });
    const onAbandoned = vi.fn(async () => {
      notificationEntered.resolve();
      await notification.promise;
      tracking.trackTrackedRunTerminalPersistence({
        runId,
        clientRunId: runId,
        persistence: persistence.promise,
      });
      publicationEntered.resolve();
    });
    const queued = createQueueTestRun({ prompt: "queued Gateway notification" });
    queued.run = {
      ...queued.run,
      agentId: "main",
      sessionKey,
      sessionId: state.entry.sessionId,
      config: state.cfg,
    };
    queued.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned, onSettled };
    bindSessionControllerSource(entry.input, queued);
    enqueueFollowupRun(
      sessionKey,
      queued,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    let acknowledged = false;
    const stopping = tryFastAbortFromMessage(state).then((result) => {
      acknowledged = true;
      return result;
    });
    try {
      await withinTest(notificationEntered.promise, signal);
      expect(acknowledged).toBe(false);
      notification.resolve();
      await withinTest(publicationEntered.promise, signal);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(acknowledged).toBe(false);
      persistence.resolve();
      expect(await withinTest(stopping, signal)).toMatchObject({ handled: true });
      expect(onAbandoned).toHaveBeenCalledOnce();
      expect(onSettled).not.toHaveBeenCalled();
      expect(isRpcSourceRegistered(entry)).toBe(true);
      expect(removed).not.toHaveBeenCalled();
      preparation.resolve();
      await withinTest(entry.input.settlement.promise, signal);
      expect(onAbandoned).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(isRpcSourceRegistered(entry)).toBe(false);
      expect(removed).toHaveBeenCalledOnce();
    } finally {
      notification.resolve();
      persistence.resolve();
      preparation.resolve();
      await Promise.allSettled([stopping, entry.input.settlement.promise]);
      registration.cleanup();
    }
  });
}
