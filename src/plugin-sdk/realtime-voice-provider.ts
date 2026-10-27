import { randomUUID } from "node:crypto";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type WebSocket from "ws";
import { sleepWithAbort } from "../infra/backoff.js";
import { materializeErrorStack } from "../infra/error-graph-internal.js";
import type { captureWsEventAsync } from "../proxy-capture/runtime.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceCloseOptions,
} from "../talk/provider-types.js";
import { RealtimeVoiceSessionLifecycle } from "../talk/realtime-session-lifecycle.js";
import type { RealtimeVoiceSessionConnection } from "../talk/realtime-session-lifecycle.js";

type LoadedBridge = {
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
        : state?.promise.then((bridge) => dispose(state, bridge));
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
              return getPlaybackState();
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
            onTranscript: (...args) => {
              const isFinal = args[2];
              if (
                isCurrent() ||
                (isFinal && closing?.connection === connection && lifecycle.isCurrent(connection))
              ) {
                request.onTranscript?.(...args);
              }
            },
          }
        : {}),
      onReady: () => {
        if (isCurrent()) {
          request.onReady?.();
          params.onProviderReady?.(loaded?.bridge);
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

type SocketClose = { code: number; reason: string };
type ConnectionParams = { url: string; headers: Record<string, string> };
type RealtimeWireEvent = { type: string; error?: unknown };

/** Shared socket/retry ownership; provider authentication and event policy remain local. */
export class RealtimeVoiceWebSocketTransport<Event extends RealtimeWireEvent> {
  private ws: WebSocket | null = null;
  private connectionUrl = "";
  private readonly flowId = randomUUID();
  private terminalError: Error | undefined;
  private reconnectReason: string | undefined;

  constructor(
    private readonly options: {
      lifecycle: RealtimeVoiceSessionLifecycle;
      providerId: string;
      label: string;
      callbacks: Pick<RealtimeVoiceBridgeCreateRequest, "onError" | "onClose" | "onEvent">;
      resolveConnection: () => ConnectionParams | Promise<ConnectionParams>;
      createSocket: (connection: ConnectionParams) => WebSocket;
      capture?: typeof captureWsEventAsync;
      onOpen: (connection: RealtimeVoiceSessionConnection) => void;
      onEvent: (event: Event, connection: RealtimeVoiceSessionConnection) => void;
      onReset: () => void;
      startupError: (error: unknown, url: string) => Error;
      fatalEventError: (error: unknown, event?: Event) => SocketClose | undefined;
      startupLimit?: { bytes: number; message: string; reason: string };
      closeOnFailedAbort?: boolean;
      reconnectBlocked?: () => string | undefined;
      onFirstReconnect?: () => void;
      maxReconnectAttempts: number;
      reconnectDelayMs: number;
      connectTimeoutMs: number;
    },
  ) {}

  get socket(): WebSocket | null {
    return this.ws;
  }

  get lifecycle() {
    return this.options.lifecycle;
  }

  async connect(): Promise<void> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    await this.lifecycle.connect((connection) => this.doConnect(connection));
  }

  isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  isConnected(): boolean {
    return this.lifecycle.isReady() && this.isOpen();
  }

  close(): void {
    const connection = this.lifecycle.currentConnection();
    if (!this.lifecycle.cancel()) {
      return;
    }
    this.options.onReset();
    if (!connection) {
      return;
    }
    const socket = this.ws;
    this.ws = null;
    if (socket && socket.readyState !== 3) {
      socket.close(1000, "Bridge closed");
    }
    this.notifyClose(connection, "completed");
  }

  rotate(reason: string): void {
    this.reconnectReason = reason;
    this.ws?.close(1000, `${reason} rotation`);
  }

  send(event: unknown, detail?: string): void {
    const socket = this.ws;
    if (socket?.readyState !== 1) {
      return;
    }
    const payload = JSON.stringify(event);
    const type =
      event && typeof event === "object" && "type" in event && typeof event.type === "string"
        ? event.type
        : "unknown";
    this.capture(this.connectionUrl, { direction: "outbound", kind: "ws-frame", payload });
    socket.send(payload);
    this.options.callbacks.onEvent?.({
      direction: "client",
      type,
      ...(detail ? { detail } : {}),
    });
  }

  fail(error: Error, connection: RealtimeVoiceSessionConnection, close: SocketClose): void {
    if (this.terminalError) {
      return;
    }
    const socket = this.ws;
    materializeErrorStack(error);
    this.terminalError = error;
    if (!this.lifecycle.failure(connection)) {
      return;
    }
    this.options.onReset();
    try {
      this.options.callbacks.onError?.(error);
    } finally {
      if (socket && socket.readyState !== 3) {
        socket.close(close.code, close.reason);
      } else {
        this.notifyClose(connection, "error");
      }
    }
  }

  private notifyClose(connection: RealtimeVoiceSessionConnection, outcome: "completed" | "error") {
    const terminal = this.lifecycle.close(connection, outcome);
    if (!terminal) {
      return;
    }
    this.reconnectReason = undefined;
    this.options.onReset();
    this.options.callbacks.onClose?.(terminal);
  }

  private async doConnect(connection: RealtimeVoiceSessionConnection): Promise<void> {
    let socket: WebSocket | undefined;
    let startupBytes = 0;
    const attempt = this.lifecycle.createConnectAttempt({
      connection,
      timeoutMs: this.options.connectTimeoutMs,
      timeoutError: () => new Error(`${this.options.label} connection timeout`),
      onTimeout: () => socket?.terminate(),
      onAbort: (outcome) => {
        if (
          (this.options.closeOnFailedAbort || outcome !== "error") &&
          socket &&
          socket.readyState !== 3
        ) {
          socket.close(1000, "connection canceled");
        }
      },
    });
    const open = (params: ConnectionParams) => {
      if (attempt.settled) {
        return;
      }
      if (!this.lifecycle.isCurrent(connection) || connection.signal.aborted) {
        attempt.resolve();
        return;
      }
      attempt.startTimeout();
      const { url } = params;
      this.connectionUrl = url;
      const ws = this.options.createSocket(params);
      socket = ws;
      this.ws = ws;
      const rejectStartup = (error: unknown) => {
        const mapped = this.options.startupError(error, url);
        if (attempt.rejectStartup(mapped) && ws.readyState !== 3) {
          ws.close(1000, "startup failed");
        }
      };
      ws.on("open", () => {
        if (!this.lifecycle.acceptsEvents(connection)) {
          ws.close(1000, "stale connection");
          return;
        }
        this.capture(url, { direction: "local", kind: "ws-open" });
        this.options.onOpen(connection);
      });
      ws.on("message", (data: Buffer) => {
        if (
          !this.lifecycle.acceptsEvents(connection) ||
          this.ws !== ws ||
          (attempt.settled && !attempt.ready)
        ) {
          return;
        }
        const limit = this.options.startupLimit;
        if (!attempt.ready && limit) {
          startupBytes += data.byteLength;
          if (startupBytes > limit.bytes) {
            const error = new Error(limit.message);
            attempt.reject(error);
            this.fail(error, connection, { code: 1009, reason: limit.reason });
            return;
          }
        }
        this.capture(url, { direction: "inbound", kind: "ws-frame", payload: data });
        let event: Event | undefined;
        try {
          // SAFETY: Providers interpret their own wire union; this transport only routes its type.
          event = JSON.parse(data.toString()) as Event;
          if (event.type === "error" && !attempt.ready) {
            rejectStartup(event.error);
            return;
          }
          this.options.onEvent(event, connection);
          if (
            event.type === "session.updated" &&
            this.lifecycle.isCurrent(connection) &&
            this.lifecycle.isReady()
          ) {
            attempt.resolve(true);
          }
        } catch (error) {
          const close = this.options.fatalEventError(error, event);
          if (close) {
            const failure = toStringifiedError(error);
            attempt.reject(failure);
            this.fail(failure, connection, close);
          } else {
            console.error(`[${this.options.providerId}] realtime event parse failed:`, error);
          }
        }
      });
      ws.on("error", (error) => {
        if (!this.lifecycle.acceptsEvents(connection) || this.ws !== ws) {
          return;
        }
        this.capture(url, { direction: "local", kind: "error", errorText: error.message });
        if (!attempt.ready) {
          rejectStartup(toStringifiedError(error));
        } else {
          this.options.callbacks.onError?.(toStringifiedError(error));
        }
      });
      ws.on("close", (code, reasonBuffer) => {
        this.capture(url, {
          direction: "local",
          kind: "ws-close",
          closeCode: code,
          meta: { reason: reasonBuffer.length ? reasonBuffer.toString("utf8") : undefined },
        });
        if (!this.lifecycle.isCurrent(connection)) {
          return;
        }
        if (this.ws === ws) {
          this.ws = null;
        }
        if (attempt.startupFailed) {
          return;
        }
        if (this.terminalError) {
          this.notifyClose(connection, "error");
          return;
        }
        if (this.lifecycle.terminalOutcome(connection) === "completed") {
          attempt.resolve();
          this.notifyClose(connection, "completed");
          return;
        }
        if (!attempt.ready && !attempt.settled) {
          attempt.reject(new Error(`${this.options.label} connection closed before ready`));
          return;
        }
        const reason = this.reconnectReason ?? "websocket-close";
        this.reconnectReason = undefined;
        void this.attemptReconnect(reason, connection);
      });
    };
    try {
      const params = this.options.resolveConnection();
      // Already-resolved credentials preserve the provider's synchronous socket startup.
      if ("then" in params) {
        void params.then(open).catch((error: unknown) => {
          if (
            !this.lifecycle.isCurrent(connection) ||
            this.lifecycle.terminalOutcome(connection) === "completed"
          ) {
            attempt.resolve();
          } else {
            attempt.reject(toStringifiedError(error));
          }
        });
      } else {
        open(params);
      }
    } catch (error) {
      attempt.reject(toStringifiedError(error));
    }
    await attempt.promise;
  }

  private async attemptReconnect(
    reason: string,
    connection: RealtimeVoiceSessionConnection,
  ): Promise<void> {
    const blocked = this.options.reconnectBlocked?.();
    if (blocked) {
      this.options.callbacks.onEvent?.({
        direction: "client",
        type: "session.reconnect.blocked",
        detail: `reason=${reason} ${blocked}`,
      });
      this.endAfterReconnect(connection);
      return;
    }
    const retry = this.lifecycle.retry(connection, this.options.maxReconnectAttempts);
    if (!retry) {
      return;
    }
    if (retry === "exhausted") {
      this.options.callbacks.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${this.options.maxReconnectAttempts}`,
      });
      this.endAfterReconnect(connection);
      return;
    }
    const { attempt } = retry;
    const delay = this.options.reconnectDelayMs * 2 ** (attempt - 1);
    if (attempt === 1) {
      this.options.onFirstReconnect?.();
    }
    this.options.callbacks.onEvent?.({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: `reason=${reason} attempt=${attempt} delayMs=${delay}`,
    });
    try {
      await sleepWithAbort(delay, retry.signal);
    } catch (error) {
      if (!retry.signal.aborted) {
        throw error;
      }
      return;
    }
    const next = this.lifecycle.reconnect(connection);
    if (!next) {
      return;
    }
    try {
      await this.doConnect(next);
      if (!this.lifecycle.isCurrent(next) || !this.lifecycle.isReady()) {
        return;
      }
      this.options.callbacks.onEvent?.({
        direction: "client",
        type: "session.reconnect.ready",
        detail: `reason=${reason} attempt=${attempt}`,
      });
    } catch (error) {
      if (!this.lifecycle.acceptsEvents(next)) {
        return;
      }
      this.options.callbacks.onError?.(toStringifiedError(error));
      await this.attemptReconnect(reason, next);
    }
  }

  private endAfterReconnect(connection: RealtimeVoiceSessionConnection) {
    if (this.lifecycle.failure(connection)) {
      this.options.onReset();
    }
    this.notifyClose(connection, "error");
  }

  private capture(
    url: string,
    event: Omit<Parameters<typeof captureWsEventAsync>[0], "url" | "flowId">,
  ) {
    void this.options
      .capture?.({
        url,
        flowId: this.flowId,
        ...event,
        meta: { provider: this.options.providerId, capability: "realtime-voice", ...event.meta },
      })
      .catch(() => {});
  }
}

// Private provider primitives; session runtimes and provider registries stay outside this leaf.
export type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
export type {
  InternalRealtimeVoiceBrowserSessionCreateRequest,
  InternalRealtimeVoiceProviderApi,
  InternalRealtimeVoiceProviderCapabilities,
} from "../talk/provider-internal.js";
export type {
  OpenAICompatibleRealtimeAudioFormat,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
export {
  normalizeRealtimeVoiceResponseOutcome,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  realtimeVoiceAudioDurationMs,
  toOpenAICompatibleRealtimeAudioFormat,
} from "../talk/provider-types.js";
export {
  createRealtimeVoiceAudioQueue,
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceAudioQueue,
  type RealtimeVoiceSessionConnection,
} from "../talk/realtime-session-lifecycle.js";
export {
  convertPcmToMulaw8k,
  createStreamingPcmResampler,
  mulawToPcm,
  pcmToMulaw,
  resamplePcm,
} from "../talk/audio-codec.js";
export {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "../talk/agent-consult-tool.js";

export { canonicalizeBase64 } from "@openclaw/media-core/base64";
export { rawDataToString } from "../infra/ws.js";
export {
  coerceErrorMessage,
  extractErrorCode,
  readErrorName,
  toErrorObject,
  toStringifiedError,
} from "@openclaw/normalization-core/error-coercion";
export { sleepWithAbort } from "../infra/backoff.js";

export { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
export { buildRealtimeVoiceAgentControlSpeechMessage } from "../talk/agent-run-control-shared.js";

export {
  createRealtimeVoiceAudioPortSender,
  type RealtimeVoiceAudioOutputPort,
  type RealtimeVoiceAudioOutputMessage,
} from "../talk/audio-output-port.js";
export { isRealtimeVoiceAudioAudible } from "../talk/audio-energy.js";
export { createRealtimeVoiceOutputActivityTracker } from "../talk/output-activity-tracker.js";
