import type { TalkClientToolCallResult } from "../../../../packages/gateway-protocol/src/schema/channels.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../../src/talk/agent-consult-tool.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  shouldAutoControlRealtimeVoiceAgentText,
} from "../../../../src/talk/agent-run-control-shared.js";
import type { RealtimeVoiceAgentControlMode } from "../../../../src/talk/agent-run-control-shared.js";
import type { TalkEvent } from "../../../../src/talk/talk-events.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
// Control UI chat module implements realtime talk shared behavior.
import { formatUiError } from "../../lib/format-error.ts";
import {
  createChatHandler,
  type ChatEventDisposition,
  type ChatPayload,
  type RealtimeTalkEventInput,
} from "./realtime-talk-chat-handler.ts";
import {
  observePendingFollowupRunId,
  type AgentWaitResult,
} from "./realtime-talk-followup-observation.ts";
import type { RealtimeTalkInputController } from "./realtime-talk-input.ts";

export type RealtimeTalkStatus = "idle" | "connecting" | "listening" | "thinking" | "error";
export type RealtimeTalkEvent = TalkEvent;

export type RealtimeTalkTranscript = {
  role: "user" | "assistant";
  text: string;
  final: boolean;
  itemId?: string;
  order?: number;
};

export type RealtimeTalkTranscriptItem =
  | {
      type: "created";
      itemId: string;
      previousItemId?: string | null;
      role: "user" | "assistant" | null;
    }
  | { type: "settled"; itemId: string };

export type RealtimeTalkCallbacks = {
  onStatus?: (status: RealtimeTalkStatus, detail?: string) => void;
  onVideoCapability?: (capable: boolean) => void;
  onInputLevel?: (level: number) => void;
  onTranscript?: (entry: RealtimeTalkTranscript) => void;
  onTranscriptOrder?: (items: ReadonlyArray<{ itemId: string; order: number }>) => void;
  onTranscriptItem?: (item: RealtimeTalkTranscriptItem) => void;
  onTalkEvent?: (event: RealtimeTalkEvent) => void;
  onVideoStream?: (stream: MediaStream | null) => void;
  onVideoError?: (error: unknown) => void;
};

export type { RealtimeTalkEventInput };

type RealtimeTalkAudioContract = {
  inputEncoding: "pcm16" | "g711_ulaw";
  inputSampleRateHz: number;
  outputEncoding: "pcm16" | "g711_ulaw";
  outputSampleRateHz: number;
};

export type RealtimeTalkWebRtcSdpSessionResult = {
  provider: string;
  transport: "webrtc";
  voiceSessionId?: string;
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  offerResponseMaxBytes?: number;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkJsonPcmWebSocketSessionResult = {
  provider: string;
  transport: "provider-websocket";
  voiceSessionId?: string;
  protocol: string;
  clientSecret: string;
  websocketUrl: string;
  audio: RealtimeTalkAudioContract;
  initialMessage?: unknown;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkGatewayRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  voiceSessionId?: string;
  relaySessionId: string;
  audio: RealtimeTalkAudioContract;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

type RealtimeTalkManagedRoomSessionResult = {
  provider: string;
  transport: "managed-room";
  voiceSessionId?: string;
  roomUrl: string;
  token?: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkSessionResult =
  | RealtimeTalkWebRtcSdpSessionResult
  | RealtimeTalkJsonPcmWebSocketSessionResult
  | RealtimeTalkGatewayRelaySessionResult
  | RealtimeTalkManagedRoomSessionResult;

export type RealtimeTalkTransportStartResult = "ready" | "cancelled";

export type RealtimeTalkTransport = {
  start(): Promise<RealtimeTalkTransportStartResult>;
  activate?: () => void;
  stop(options?: { emitClosed?: boolean }): void;
  setVideoEnabled?: (enabled: boolean) => Promise<void>;
  switchCamera?: (videoDeviceId: string | undefined) => Promise<void>;
};

export type RealtimeTalkTransportContext = {
  client: GatewayBrowserClient;
  sessionKey: string;
  voiceSessionId?: string;
  flushTranscriptWrites?: () => Promise<void>;
  callbacks: RealtimeTalkCallbacks;
  input: Pick<RealtimeTalkInputController, "stream" | "adopt" | "stop">;
  videoDeviceId?: string;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export function createRealtimeTalkEventEmitter(
  ctx: RealtimeTalkTransportContext,
  session: RealtimeTalkSessionResult,
): (input: RealtimeTalkEventInput) => void {
  let seq = 0;
  let turnSeq = 0;
  let activeTurnId: string | undefined;
  const sessionId = resolveRealtimeTalkEventSessionId(ctx, session);
  return (input) => {
    if (!ctx.callbacks.onTalkEvent) {
      return;
    }
    const turnId = resolveRealtimeTalkTurnId(input);
    seq += 1;
    ctx.callbacks.onTalkEvent({
      id: `${sessionId}:${seq}`,
      type: input.type,
      sessionId,
      turnId,
      captureId: input.captureId,
      seq,
      timestamp: new Date().toISOString(),
      mode: "realtime",
      transport: session.transport,
      brain: "agent-consult",
      provider: session.provider,
      final: input.final,
      callId: input.callId,
      itemId: input.itemId,
      parentId: input.parentId,
      payload: input.payload ?? null,
    });
    if (
      input.type === "turn.ended" ||
      input.type === "turn.cancelled" ||
      input.type === "session.replaced" ||
      input.type === "session.closed"
    ) {
      activeTurnId = undefined;
    }
  };

  function resolveRealtimeTalkTurnId(input: RealtimeTalkEventInput): string | undefined {
    if (input.type === "turn.started") {
      activeTurnId = input.turnId ?? activeTurnId ?? `turn-${++turnSeq}`;
      return activeTurnId;
    }
    if (!isTurnScopedTalkEvent(input.type)) {
      return input.turnId;
    }
    activeTurnId = input.turnId ?? activeTurnId ?? `turn-${++turnSeq}`;
    return activeTurnId;
  }
}

function isTurnScopedTalkEvent(type: RealtimeTalkEvent["type"]): boolean {
  return (
    type === "turn.ended" ||
    type === "turn.cancelled" ||
    type.startsWith("input.audio.") ||
    type.startsWith("transcript.") ||
    type.startsWith("output.") ||
    type.startsWith("tool.")
  );
}

function resolveRealtimeTalkEventSessionId(
  ctx: RealtimeTalkTransportContext,
  session: RealtimeTalkSessionResult,
): string {
  const explicitSessionId = (session as { sessionId?: unknown }).sessionId;
  if (typeof explicitSessionId === "string" && explicitSessionId.trim()) {
    return explicitSessionId.trim();
  }
  if ("relaySessionId" in session && session.relaySessionId.trim()) {
    return session.relaySessionId;
  }
  return `${ctx.sessionKey}:${session.provider}:${session.transport}`;
}

export type { ChatPayload };

const EMPTY_FINAL_FALLBACK_GRACE_MS = 500;
const EMPTY_FINAL_FALLBACK_TEXT = "OpenClaw finished with no text.";

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function getTerminalAgentWaitError(result: AgentWaitResult | undefined): Error | undefined {
  if (!result) {
    return undefined;
  }
  const message = result.error?.trim();
  if (result.status === "error") {
    return new Error(message || "OpenClaw tool call failed");
  }
  // pending means the turn is queued/deferred — not terminal, so keep waiting.
  if (result.status === "pending") {
    return undefined;
  }
  if (result.status !== "timeout" || result.pendingError) {
    return undefined;
  }
  const stopReason = result.stopReason?.trim();
  const timeoutPhase = result.timeoutPhase?.trim();
  const livenessState = result.livenessState?.trim();
  const hasTerminalTimeoutMetadata =
    result.endedAt !== undefined ||
    message !== undefined ||
    result.aborted === true ||
    (livenessState !== undefined && livenessState.length > 0) ||
    result.yielded === true ||
    (stopReason !== undefined && stopReason.length > 0) ||
    timeoutPhase === "preflight" ||
    timeoutPhase === "provider" ||
    timeoutPhase === "post_turn" ||
    result.providerStarted === true;
  if (hasTerminalTimeoutMetadata) {
    return new Error(message || "OpenClaw tool call timed out");
  }
  return undefined;
}

function waitForChatResult(params: {
  client: GatewayBrowserClient;
  runId: string;
  timeoutMs: number;
  emitTalkEvent?: (input: RealtimeTalkEventInput) => void;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new DOMException("OpenClaw tool call aborted", "AbortError"));
      return;
    }
    let settled = false;
    let emptyFinalWaitStarted = false;
    let emptyFinalFallbackTimer: number | undefined;
    let observePendingFollowupRunIdAbort = () => {};

    const settleResolve = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: Error | DOMException) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const chatHandler = createChatHandler({
      runId: params.runId,
      emitTalkEvent: params.emitTalkEvent,
      extractTextFromMessage,
    });

    const applyDisposition = (d: ChatEventDisposition) => {
      if (settled) {
        return;
      }
      if (d.type === "terminal") {
        settleResolve(d.text ?? EMPTY_FINAL_FALLBACK_TEXT);
      } else if (d.type === "empty_final_fallback") {
        // Empty final from a known run. If the follow-up hasn't been discovered
        // yet, query the gateway to check for a pending queued follow-up.
        if (chatHandler.getAcceptedFollowupRunId() === undefined) {
          waitForEmptyFinalFallback();
        } else {
          emptyFinalFallbackTimer = window.setTimeout(() => {
            settleResolve(EMPTY_FINAL_FALLBACK_TEXT);
          }, EMPTY_FINAL_FALLBACK_GRACE_MS);
        }
      } else if (d.type === "aborted") {
        settleReject(
          new DOMException(d.errorMessage ?? "OpenClaw tool call aborted", "AbortError"),
        );
      } else if (d.type === "errored") {
        settleReject(new Error(d.errorMessage ?? "OpenClaw tool call failed"));
      }
    };

    /** Set the discovered follow-up runId on the handler and replay any
     * buffered events that arrived before discovery, recovering terminal
     * results (final, aborted, error) that would otherwise be lost. */
    const onFollowupRunIdDiscovered = (followupRunId: string) => {
      chatHandler.setAcceptedFollowupRunId(followupRunId);
      for (const d of chatHandler.replayBufferedFollowupEvents()) {
        applyDisposition(d);
      }
    };

    const waitForEmptyFinalFallback = () => {
      if (emptyFinalWaitStarted) {
        return;
      }
      emptyFinalWaitStarted = true;
      void params.client
        .request<AgentWaitResult>("agent.wait", {
          runId: params.runId,
          timeoutMs: params.timeoutMs,
        })
        .then((result) => {
          if (settled) {
            return;
          }
          const waitError = getTerminalAgentWaitError(result);
          if (waitError) {
            settleReject(waitError);
            return;
          }
          if (result?.status === "timeout") {
            return;
          }
          // pending (queued turn) is non-terminal — the gateway's waitForTurn
          // returns the same runId and, when a follow-up has been admitted,
          // includes the follow-up's runId in the response. Chat events for the
          // follow-up carry that runId, so we only accept events matching it.
          if (result?.status === "pending") {
            if (result.followupRunId) {
              onFollowupRunIdDiscovered(result.followupRunId);
              return;
            }
            // The follow-up ID may not be allocated yet — observe the queue
            // entry so we can capture it when admission completes.
            observePendingFollowupRunIdAbort = observePendingFollowupRunId({
              client: params.client,
              runId: params.runId,
              timeoutMs: params.timeoutMs,
              isSettled: () => settled,
              isFollowupObserved: () => chatHandler.getAcceptedFollowupRunId() !== undefined,
              onFollowupObserved: onFollowupRunIdDiscovered,
              onError: settleReject,
            });
            return;
          }
          emptyFinalFallbackTimer = window.setTimeout(() => {
            settleResolve(EMPTY_FINAL_FALLBACK_TEXT);
          }, EMPTY_FINAL_FALLBACK_GRACE_MS);
        })
        .catch((error: unknown) => {
          settleReject(error instanceof Error ? error : new Error(String(error)));
        });
    };

    const timer = window.setTimeout(() => {
      settleReject(new Error("OpenClaw tool call timed out"));
    }, params.timeoutMs);

    const onAbort = () => {
      settleReject(new DOMException("OpenClaw tool call aborted", "AbortError"));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = params.client.addEventListener((evt: GatewayEventFrame) => {
      const d = chatHandler.handleEvent(evt);
      if (d) {
        applyDisposition(d);
      }
    });

    function cleanup() {
      window.clearTimeout(timer);
      if (emptyFinalFallbackTimer !== undefined) {
        window.clearTimeout(emptyFinalFallbackTimer);
      }
      observePendingFollowupRunIdAbort();
      params.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      chatHandler.cleanup();
    }
  });
}

export async function steerRealtimeTalkActiveConsult(params: {
  ctx: RealtimeTalkTransportContext;
  text: string;
  mode?: RealtimeVoiceAgentControlMode;
  sessionId?: string;
  emitTalkEvent?: (input: RealtimeTalkEventInput) => void;
  onControlResult?: (result: unknown) => void;
  speakControlResult?: (message: string) => void;
  suppressSpeechForModes?: readonly RealtimeVoiceAgentControlMode[];
}): Promise<void> {
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const request =
    params.sessionId && params.sessionId.trim()
      ? params.ctx.client.request("talk.session.steer", {
          sessionId: params.sessionId,
          sessionKey: params.ctx.sessionKey,
          text,
          ...(params.mode ? { mode: params.mode } : {}),
        })
      : params.ctx.client.request("talk.client.steer", {
          sessionKey: params.ctx.sessionKey,
          text,
          ...(params.mode ? { mode: params.mode } : {}),
        });
  try {
    const result = await request;
    params.onControlResult?.(result);
    maybeSpeakRealtimeTalkControlResult(
      result,
      params.speakControlResult,
      params.suppressSpeechForModes,
    );
    params.emitTalkEvent?.({
      type: "tool.progress",
      payload: {
        name: "openclaw_agent_control",
        result,
      },
      final:
        result && typeof result === "object" && "mode" in result
          ? result.mode === "status" || result.mode === "cancel"
          : undefined,
    });
  } catch (error) {
    params.emitTalkEvent?.({
      type: "tool.error",
      payload: { message: formatUiError(error) },
      final: true,
    });
  }
}

export async function submitRealtimeTalkAgentControl(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void | Promise<void>;
  callId: string;
  sessionId?: string;
  emitTalkEvent?: (input: RealtimeTalkEventInput) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    return;
  }
  let result: unknown;
  let talkEvent: RealtimeTalkEventInput;
  try {
    const parsed = parseRealtimeVoiceAgentControlToolArgs(params.args);
    result =
      params.sessionId && params.sessionId.trim()
        ? await params.ctx.client.request("talk.session.steer", {
            sessionId: params.sessionId,
            sessionKey: params.ctx.sessionKey,
            text: parsed.text,
            mode: parsed.mode,
          })
        : await params.ctx.client.request("talk.client.steer", {
            sessionKey: params.ctx.sessionKey,
            text: parsed.text,
            mode: parsed.mode,
          });
    if (params.signal?.aborted) {
      return;
    }
    talkEvent = {
      type: "tool.progress",
      callId: params.callId,
      payload: {
        name: "openclaw_agent_control",
        result,
      },
      final:
        result && typeof result === "object" && "mode" in result
          ? result.mode === "status" || result.mode === "cancel"
          : undefined,
    };
  } catch (error) {
    const message = formatUiError(error);
    talkEvent = {
      type: "tool.error",
      callId: params.callId,
      payload: { message },
      final: true,
    };
    result = { error: message };
    if (params.signal?.aborted || isAbortError(error)) {
      return;
    }
  }
  await params.submit(params.callId, result);
  if (params.signal?.aborted) {
    return;
  }
  params.emitTalkEvent?.(talkEvent);
}

function maybeSpeakRealtimeTalkControlResult(
  result: unknown,
  speakControlResult: ((message: string) => void) | undefined,
  suppressSpeechForModes: readonly RealtimeVoiceAgentControlMode[] | undefined,
): void {
  if (!speakControlResult || !result || typeof result !== "object") {
    return;
  }
  const record = result as Record<string, unknown>;
  const mode =
    typeof record.mode === "string" ? (record.mode as RealtimeVoiceAgentControlMode) : undefined;
  if (mode && suppressSpeechForModes?.includes(mode)) {
    return;
  }
  const message = typeof record.message === "string" ? record.message.trim() : "";
  const shouldSpeak =
    (record.speak === true && record.suppress !== true) ||
    (record.ok === true && mode === "steer" && record.suppress === true);
  if (shouldSpeak && message) {
    speakControlResult(buildRealtimeVoiceAgentControlSpeechMessage(message));
  }
}

export async function submitRealtimeTalkConsult(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void | Promise<void>;
  callId: string;
  relaySessionId?: string;
  emitTalkEvent?: (input: RealtimeTalkEventInput) => void;
  submitAbortResult?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const { ctx, callId, submit } = params;
  ctx.callbacks.onStatus?.("thinking");
  let run: TalkClientToolCallResult | undefined;
  let aborted = false;
  let submitted = false;
  let submissionCompleted = false;
  const submitOnce = async (result: unknown): Promise<void> => {
    if (submitted) {
      return;
    }
    submitted = true;
    await submit(callId, result);
    submissionCompleted = true;
  };
  const submitAbortResult = async (): Promise<void> => {
    if (params.submitAbortResult !== false) {
      await submitOnce(buildRealtimeVoiceAgentCancelProviderResult());
    }
  };
  const abortRun = () => {
    aborted = true;
    if (run) {
      void ctx.client.request("chat.abort", {
        sessionKey: run.agentSessionKey,
        agentId: run.agentId,
        runId: run.runId,
      });
    }
  };
  if (params.signal?.aborted) {
    await submitAbortResult();
    return;
  }
  params.signal?.addEventListener("abort", abortRun, { once: true });
  try {
    const args =
      typeof params.args === "string" ? JSON.parse(params.args || "{}") : (params.args ?? {});
    await ctx.flushTranscriptWrites?.();
    if (params.signal?.aborted) {
      await submitAbortResult();
      return;
    }
    // Cancellation must not hide the acknowledgement that owns the Gateway run.
    // Once the run id arrives, abortRun() can cancel the exact started consult.
    run = await ctx.client.request<TalkClientToolCallResult>("talk.client.toolCall", {
      sessionKey: ctx.sessionKey,
      ...(ctx.voiceSessionId ? { voiceSessionId: ctx.voiceSessionId } : {}),
      callId,
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args,
      ...(params.relaySessionId ? { relaySessionId: params.relaySessionId } : {}),
    });
    if (params.signal?.aborted) {
      abortRun();
      await submitAbortResult();
      return;
    }
    const result = await waitForChatResult({
      client: ctx.client,
      runId: run.runId,
      timeoutMs: 120_000,
      emitTalkEvent: params.emitTalkEvent,
      signal: params.signal,
    });
    await submitOnce({ result });
  } catch (error) {
    if (submitted) {
      throw error;
    }
    if (aborted || params.signal?.aborted || isAbortError(error)) {
      await submitAbortResult();
      return;
    }
    await submitOnce({
      error: formatUiError(error),
    });
  } finally {
    params.signal?.removeEventListener("abort", abortRun);
    if (submissionCompleted && !aborted && !params.signal?.aborted) {
      ctx.callbacks.onStatus?.("listening");
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

export {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  shouldAutoControlRealtimeVoiceAgentText,
};
