import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceCloseOptions,
} from "./provider-types.js";
import {
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceSessionConnection,
} from "./realtime-session-lifecycle.js";

type LoadedBridge = {
  connection: RealtimeVoiceSessionConnection;
  promise: Promise<RealtimeVoiceBridge>;
  bridge?: RealtimeVoiceBridge;
  closeOptions?: RealtimeVoiceCloseOptions;
};

/** Owns a lazy bridge generation while provider-local queues own input admission and ordering. */
export function createLazyRealtimeVoiceBridgeLifecycle(params: {
  label: string;
  request: RealtimeVoiceBridgeCreateRequest;
  load: (request: RealtimeVoiceBridgeCreateRequest) => Promise<RealtimeVoiceBridge>;
  clearPending: () => void;
  onProviderReady?: (bridge: RealtimeVoiceBridge | undefined) => void;
  onConnected?: (bridge: RealtimeVoiceBridge, isCurrent: () => boolean) => void | Promise<void>;
}) {
  const request = params.request;
  const { getPlaybackState, handleDelegationInput, runAgentConsult } = request;
  const lifecycle = new RealtimeVoiceSessionLifecycle(`${params.label} lazy`);
  const disposedBridges = new WeakMap<RealtimeVoiceBridge, void | Promise<void>>();
  let loaded: LoadedBridge | undefined;
  let closePromise: Promise<void> | undefined;
  let closing:
    | { connection: RealtimeVoiceSessionConnection | undefined; outcome: "completed" | "error" }
    | undefined;

  const dispose = (state: LoadedBridge, bridge: RealtimeVoiceBridge): void | Promise<void> => {
    if (disposedBridges.has(bridge)) {
      return disposedBridges.get(bridge);
    }
    // Claim before invoking provider code: close can synchronously reenter this owner.
    disposedBridges.set(bridge, undefined);
    const completion = state.closeOptions ? bridge.close(state.closeOptions) : bridge.close();
    disposedBridges.set(bridge, completion);
    return completion;
  };
  const notifyTerminal = (
    connection: RealtimeVoiceSessionConnection,
    outcome: "completed" | "error",
  ) => {
    if (closing?.connection === connection && lifecycle.isCurrent(connection)) {
      if (outcome === "error") {
        closing.outcome = outcome;
      }
      return;
    }
    const reason = lifecycle.close(connection, outcome);
    if (reason) {
      params.clearPending();
      request.onClose?.(reason);
    }
  };
  const close = (
    outcome: "completed" | "error",
    primaryError?: unknown,
    options?: RealtimeVoiceCloseOptions,
  ): void | Promise<void> => {
    const connection = lifecycle.currentConnection();
    const started =
      outcome === "error" && connection ? lifecycle.failure(connection) : lifecycle.cancel();
    if (!started) {
      return closePromise;
    }
    const state = loaded;
    if (state) {
      state.closeOptions = options;
    }
    const owner = { connection, outcome };
    closing = owner;
    params.clearPending();
    const finish = (reason = owner.outcome) => {
      if (closing === owner) {
        closing = undefined;
        if (outcome === "error") {
          try {
            request.onError?.(toStringifiedError(primaryError));
          } catch {
            // Observer failures cannot skip final notification or replace the disposal outcome.
          }
        }
      }
      if (connection ? lifecycle.close(connection, reason) : !lifecycle.currentConnection()) {
        request.onClose?.(reason);
      }
    };
    const fail = (error: unknown): never => {
      try {
        finish("error");
      } catch {
        // The provider's disposal failure takes precedence over an observer's failure.
      }
      throw error;
    };
    let pending: void | Promise<void>;
    try {
      pending = state?.bridge
        ? dispose(state, state.bridge)
        : state && state.connection === connection
          ? state.promise.then((bridge) => dispose(state, bridge))
          : undefined;
    } catch (error) {
      return fail(error);
    }
    if (pending) {
      const completion = pending.then(() => finish(), fail);
      if (closing === owner) {
        closePromise = completion;
      }
      return completion;
    }
    finish();
  };
  const guardRequest = (connection: RealtimeVoiceSessionConnection) => {
    const isCurrent = () => lifecycle.acceptsEvents(connection);
    const guard =
      <TArgs extends unknown[]>(callback: (...args: TArgs) => void) =>
      (...args: TArgs) => {
        if (isCurrent()) {
          callback(...args);
        }
      };
    return {
      ...request,
      onAudio: guard(request.onAudio),
      onClearAudio: guard(request.onClearAudio),
      ...(request.onMark ? { onMark: guard(request.onMark) } : {}),
      ...(request.onEvent ? { onEvent: guard(request.onEvent) } : {}),
      ...(request.onResponseDone ? { onResponseDone: guard(request.onResponseDone) } : {}),
      ...(request.onToolCall ? { onToolCall: guard(request.onToolCall) } : {}),
      ...(request.onError ? { onError: guard(request.onError) } : {}),
      ...(getPlaybackState
        ? {
            getPlaybackState: () => {
              if (!isCurrent()) {
                return [];
              }
              const playback = getPlaybackState();
              return isCurrent() ? playback : [];
            },
          }
        : {}),
      ...(handleDelegationInput
        ? {
            handleDelegationInput: (text, respond) => {
              if (!isCurrent()) {
                return "control";
              }
              return handleDelegationInput(text, (message) => {
                if (isCurrent()) {
                  respond(message);
                }
              });
            },
          }
        : {}),
      ...(runAgentConsult
        ? {
            runAgentConsult: (input) =>
              isCurrent()
                ? runAgentConsult(input)
                : Promise.reject(new Error(`${params.label} realtime voice session closed`)),
          }
        : {}),
      ...(request.onTranscript
        ? {
            onTranscript: (role, text, isFinal) => {
              if (
                isCurrent() ||
                (isFinal && closing?.connection === connection && lifecycle.isCurrent(connection))
              ) {
                request.onTranscript?.(role, text, isFinal);
              }
            },
          }
        : {}),
      onReady: () => {
        if (isCurrent()) {
          request.onReady?.();
          if (isCurrent()) {
            params.onProviderReady?.(loaded?.bridge);
          }
        }
      },
      onClose: (reason) => notifyTerminal(connection, reason),
    } satisfies RealtimeVoiceBridgeCreateRequest;
  };

  return {
    get bridge() {
      return loaded?.bridge;
    },
    isActive: () => lifecycle.phase() !== "terminal",
    connect: () =>
      lifecycle.connect(async (connection) => {
        closePromise = undefined;
        closing = undefined;
        // Publish the load before factory callbacks can close or reconnect this wrapper.
        const state: LoadedBridge = {
          connection,
          promise: Promise.resolve().then(() => params.load(guardRequest(connection))),
        };
        loaded = state;
        const bridge = await state.promise;
        const isCurrent = () => lifecycle.acceptsEvents(connection);
        if (!isCurrent()) {
          await dispose(state, bridge);
          return;
        }
        state.bridge = bridge;
        try {
          await bridge.connect();
          if (isCurrent()) {
            await params.onConnected?.(bridge, isCurrent);
            lifecycle.ready(connection);
          }
        } catch (error) {
          try {
            if (isCurrent()) {
              await close("error", error);
            } else {
              await dispose(state, bridge);
            }
          } catch {
            // Cleanup and observer failures cannot replace the original startup failure.
          }
          throw error;
        }
        if (!isCurrent()) {
          await dispose(state, bridge);
        }
      }),
    close: (options?: RealtimeVoiceCloseOptions) => close("completed", undefined, options),
  };
}
