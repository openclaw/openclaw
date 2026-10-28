import type { SessionEntry } from "../config/sessions/types.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type { createSessionObserverCompanionSnapshotReader } from "./session-observer-companion.js";
import type { SessionObserverEvent } from "./session-observer-contract.js";
import type {
  SessionObserverDeps,
  SessionObserverRead,
  SessionObserverState,
} from "./session-observer-model.js";
import { captureSessionObserverRead } from "./session-observer-read.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

export type SessionObserverEventSteps = Generator<
  | { sessionKey: string; agentId: string; reader?: SessionObserverRead }
  | { work: Promise<unknown> },
  void,
  SessionEntry | undefined
>;

/** The observer's accepted work settles independently of scheduler cancellation. */
export function createSessionObserverWork(params: {
  deps: SessionObserverDeps;
  companionReader: ReturnType<typeof createSessionObserverCompanionSnapshotReader>;
  states: ReadonlyMap<string, SessionObserverState>;
  handleEventSteps: (
    event: SessionObserverEvent,
    settledError?: boolean,
    reader?: SessionObserverRead,
  ) => SessionObserverEventSteps;
  canPublish: (state: SessionObserverState, session: SessionEntry | undefined) => boolean;
  beginClose: () => void;
  finishClose: () => void;
  reportError: (error: unknown) => void;
}) {
  let disposed = false;
  let closing = false;
  let disposal: Promise<void> | undefined;
  const acceptedWork = new AsyncWorkScope();
  let eventTail = Promise.resolve();
  const resetting = new Map<string, object>();
  const reportError = params.reportError;
  const background = (run: () => Promise<unknown>) => {
    void runInDetachedAsyncContext(() => acceptedWork.track(run)).catch(reportError);
  };
  const getRunReader = (event: SessionObserverEvent) => {
    const sessionKey = event.sessionKey?.trim();
    const agentId = event.agentId?.trim();
    const state =
      sessionKey && agentId
        ? params.states.get(resolveSessionSubscriptionKey(sessionKey, agentId))
        : undefined;
    return state?.runId === event.runId && state.agentId === agentId ? state.reader : undefined;
  };
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    if (disposal) {
      return Promise.reject(new Error("Session observer is closed"));
    }
    const result = acceptedWork.track(() => eventTail.then(run));
    eventTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  function handleEvent(event: SessionObserverEvent, settledError = false) {
    warnPluginSdkDeprecation({
      family: "session-observer",
      method: "sessionObserver.handleEvent",
      replacement: "await sessionObserver.handleEventAsync",
    });
    if (disposal) {
      return;
    }
    void runInDetachedAsyncContext(() => handleEventAsync(event, settledError)).catch(reportError);
  }

  async function handleEventAsync(
    event: SessionObserverEvent,
    settledError = false,
    captured?: SessionObserverRead,
  ) {
    if (disposal) {
      throw new Error("Session observer is closed");
    }
    const sessionKey = event.sessionKey ?? "";
    const agentId = event.agentId ?? "";
    const reader =
      captured ??
      getRunReader(event) ??
      (sessionKey && agentId
        ? captureSessionObserverRead(params.deps, sessionKey, agentId)
        : undefined);
    return enqueue(async () => {
      const steps = params.handleEventSteps(event, settledError, reader);
      let next = steps.next();
      while (!next.done) {
        if ("work" in next.value) {
          await next.value.work;
          next = steps.next(undefined);
        } else {
          const source = next.value.reader ?? reader;
          if (!source) {
            throw new Error("Session observer event has no captured source");
          }
          next = await source.withRead((session) => {
            source.assertCurrent();
            return steps.next(session);
          });
        }
      }
    });
  }

  function disposeAsync() {
    if (!disposal) {
      // Reject new events now; accepted events still own their publication and persistence.
      disposal = eventTail
        .then(() => {
          closing = true;
          params.beginClose();
          return AsyncWorkScope.runWhenAllIdle(
            () => [acceptedWork],
            () => acceptedWork.drain(),
          );
        })
        .then(() => {
          if (!disposed) {
            disposed = true;
            params.finishClose();
          }
        });
    }
    return disposal;
  }
  return {
    get closing() {
      return closing;
    },
    get disposed() {
      return disposed;
    },
    resetting,
    background,
    handleEvent,
    handleEventAsync,
    disposeAsync,
    dispose: () => {
      warnPluginSdkDeprecation({
        family: "session-observer",
        method: "sessionObserver.dispose",
        replacement: "await sessionObserver.disposeAsync",
      });
      if (disposed) {
        return;
      }
      disposed = true;
      void disposeAsync().catch(reportError);
      params.finishClose();
    },
    async withCurrent<T>(
      reader: SessionObserverRead | undefined,
      sessionKey: string,
      agentId: string,
      consume: (session: SessionEntry | undefined) => T,
    ) {
      return reader
        ? reader.withRead((session) => {
            reader.assertCurrent();
            return consume(session);
          })
        : captureSessionObserverRead(params.deps, sessionKey, agentId).withRead(consume);
    },
    refreshAfterReset(
      sessionKey: string,
      agentId: string,
      consume: (session: SessionEntry | undefined) => void,
    ) {
      const scopeKey = resolveSessionSubscriptionKey(sessionKey, agentId);
      if (disposal) {
        return;
      }
      const reader = captureSessionObserverRead(params.deps, sessionKey, agentId);
      const reset = {};
      resetting.set(scopeKey, reset);
      void enqueue(async () => {
        try {
          await reader.withRead((session) => {
            reader.assertCurrent();
            consume(session);
          });
        } finally {
          if (resetting.get(scopeKey) === reset) {
            resetting.delete(scopeKey);
          }
        }
      }).catch(reportError);
    },
    preparePublication(
      this: void,
      state: SessionObserverState,
      publish: () => void,
    ): Promise<void> {
      const consume = (session: SessionEntry | undefined) => {
        if (params.canPublish(state, session)) {
          publish();
        }
      };
      const reader =
        state.reader ?? captureSessionObserverRead(params.deps, state.sessionKey, state.agentId);
      return acceptedWork.track(() => reader.withRead(consume)).catch(reportError);
    },
    async getCompanionSnapshotAsync(this: void, sessionKey: string, selectedAgentId?: string) {
      if (disposal) {
        throw new Error("Session observer is closed");
      }
      const target = params.companionReader.resolve(sessionKey, selectedAgentId);
      const reader = captureSessionObserverRead(
        params.deps,
        target.canonicalSessionKey,
        target.agentId,
      );
      return enqueue(async () =>
        reader.withRead((session) => {
          reader.assertCurrent();
          return params.companionReader.read(target, session);
        }),
      );
    },
  };
}
