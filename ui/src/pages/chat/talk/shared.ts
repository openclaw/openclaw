import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { TalkClientToolCallResult } from "../../../../../packages/gateway-protocol/src/schema/channels.js";
import type { AgentWaitResult as GatewayAgentWaitResult } from "../../../../../src/agents/run-wait.types.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../../../src/talk/agent-consult-tool.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  shouldAutoControlRealtimeVoiceAgentText,
} from "../../../../../src/talk/agent-run-control-shared.js";
import type { RealtimeVoiceAgentControlMode } from "../../../../../src/talk/agent-run-control-shared.js";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceCloseOptions,
} from "../../../../../src/talk/provider-types.js";
import type { TalkEvent } from "../../../../../src/talk/talk-events.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../../api/gateway.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import type { RealtimeTalkInputOwner } from "./input.ts";

export type RealtimeTalkStatus = "idle" | "connecting" | "listening" | "thinking" | "error";
export type RealtimeTalkEvent = TalkEvent;

export type RealtimeTalkTranscript = {
  role: "user" | "assistant";
  text: string;
  final: boolean;
  /** Literal fragments append; complete snapshots replace without inferred turn boundaries. */
  textMode?: "verbatim" | "snapshot";
  itemId?: string;
  transcriptId?: string;
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
  onInputNotice?: (detail: string) => void;
  onVideoCapability?: (capable: boolean) => void;
  onInputLevel?: (level: number) => void;
  onTranscript?: (entry: RealtimeTalkTranscript) => void;
  onTranscriptOrder?: (items: ReadonlyArray<{ itemId: string; order: number }>) => void;
  onTranscriptItem?: (item: RealtimeTalkTranscriptItem) => void;
  onTalkEvent?: (event: { type: "session.ready" | "session.closed" }) => void;
  onVideoStream?: (stream: MediaStream | null) => void;
  onVideoError?: (error: unknown) => void;
};

export type RealtimeTalkSessionResult = RealtimeVoiceBrowserSession & {
  voiceSessionId?: string;
};

export type RealtimeTalkWebRtcSdpSessionResult = Extract<
  RealtimeTalkSessionResult,
  { transport: "webrtc" }
>;

export type RealtimeTalkJsonPcmWebSocketSessionResult = Extract<
  RealtimeTalkSessionResult,
  { transport: "provider-websocket" }
>;

export type RealtimeTalkGatewayRelaySessionResult = Extract<
  RealtimeTalkSessionResult,
  { transport: "gateway-relay" }
>;

export type RealtimeTalkTransportStartResult = "ready" | "cancelled";

export type RealtimeTalkTransport = {
  start(): Promise<RealtimeTalkTransportStartResult>;
  activate?: () => void;
  stop(options?: RealtimeVoiceCloseOptions & { emitClosed?: boolean }): void | Promise<void>;
  setVideoEnabled?: (enabled: boolean) => Promise<void>;
  switchCamera?: (videoDeviceId: string | undefined) => Promise<void>;
};

export type RealtimeTalkTransportContext = {
  client: GatewayBrowserClient;
  sessionKey: string;
  voiceSessionId?: string;
  flushTranscriptWrites?: () => Promise<void>;
  callbacks: RealtimeTalkCallbacks;
  input: Pick<RealtimeTalkInputOwner, "stream" | "adopt" | "stop">;
  videoDeviceId?: string;
};

type ChatPayload = {
  runId?: string;
  state?: string;
  errorMessage?: string;
  message?: unknown;
};

type AgentWaitResult = Omit<Partial<GatewayAgentWaitResult>, "status" | "timeoutPhase"> & {
  status?: string;
  timeoutPhase?: string;
  aborted?: boolean;
};

const EMPTY_FINAL_FALLBACK_GRACE_MS = 500;

function extractTextFromMessage(message: unknown): string {
  const record = asOptionalObjectRecord(message);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content
    .map((block) => {
      const entry = asOptionalObjectRecord(block);
      return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
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
  return hasTerminalTimeoutMetadata
    ? new Error(message || "OpenClaw tool call timed out")
    : undefined;
}

// Settlement releases this wait's Gateway subscription, abort listener, and timers together.
export function waitForChatResult(params: {
  client: GatewayBrowserClient;
  runId: string;
  timeoutMs: number;
  timeoutMessage?: string;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new DOMException("OpenClaw tool call aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      settle(new Error(params.timeoutMessage ?? "OpenClaw tool call timed out"));
    }, params.timeoutMs);
    let settled = false;
    let emptyFinalWaitStarted = false;
    let emptyFinalFallbackTimer: number | undefined;
    const onAbort = () => {
      settle(new DOMException("OpenClaw tool call aborted", "AbortError"));
    };
    const disposeAbort = params.signal && listen(params.signal, "abort", onAbort, { once: true });
    let unsubscribe: () => void = () => undefined;
    const settle = (result: string | Error | DOMException) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      if (emptyFinalFallbackTimer !== undefined) {
        window.clearTimeout(emptyFinalFallbackTimer);
      }
      disposeAbort?.();
      unsubscribe();
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(result);
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
            settle(waitError);
            return;
          }
          if (result?.status === "timeout") {
            return;
          }
          emptyFinalFallbackTimer = window.setTimeout(() => {
            settle("OpenClaw finished with no text.");
          }, EMPTY_FINAL_FALLBACK_GRACE_MS);
        })
        .catch((error: unknown) => {
          settle(error instanceof Error ? error : new Error(String(error)));
        });
    };
    unsubscribe = params.client.addEventListener((evt: GatewayEventFrame) => {
      if (evt.event !== "chat") {
        return;
      }
      const payload = evt.payload as ChatPayload | undefined;
      if (!payload || payload.runId !== params.runId) {
        return;
      }
      if (payload.state === "final") {
        const finalText = extractTextFromMessage(payload.message);
        if (finalText) {
          settle(finalText);
          return;
        }
        waitForEmptyFinalFallback();
      } else if (payload.state === "aborted") {
        settle(
          new DOMException(payload.errorMessage ?? "OpenClaw tool call aborted", "AbortError"),
        );
      } else if (payload.state === "error") {
        settle(new Error(payload.errorMessage ?? "OpenClaw tool call failed"));
      }
    });
  });
}

function requestRealtimeTalkSteer(
  ctx: RealtimeTalkTransportContext,
  sessionId: string | undefined,
  text: string,
  mode?: RealtimeVoiceAgentControlMode,
): Promise<unknown> {
  const request = {
    sessionKey: ctx.sessionKey,
    text,
    ...(mode ? { mode } : {}),
  };
  return sessionId && sessionId.trim()
    ? ctx.client.request("talk.session.steer", { sessionId, ...request })
    : ctx.client.request("talk.client.steer", request);
}

export function shouldInterruptRealtimeTalkControlResponse(result: unknown): boolean {
  const record = asOptionalObjectRecord(result);
  return (
    record?.ok === true &&
    (record.mode === "cancel" || (record.suppress === true && record.mode !== "steer"))
  );
}

export async function steerRealtimeTalkActiveConsult(params: {
  ctx: RealtimeTalkTransportContext;
  text: string;
  onControlResult?: (result: unknown) => void;
  speakControlResult?: (message: string) => void;
}): Promise<void> {
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const request = requestRealtimeTalkSteer(params.ctx, undefined, text);
  try {
    const result = await request;
    params.onControlResult?.(result);
    const record = asOptionalObjectRecord(result);
    if (params.speakControlResult && record && record.mode !== "cancel") {
      const message = typeof record.message === "string" ? record.message.trim() : "";
      const shouldSpeak =
        (record.speak === true && record.suppress !== true) ||
        (record.ok === true && record.mode === "steer" && record.suppress === true);
      if (shouldSpeak && message) {
        params.speakControlResult(buildRealtimeVoiceAgentControlSpeechMessage(message));
      }
    }
  } catch {
    // Steering failure must not reject the transport's fire-and-forget callback.
  }
}

export async function submitRealtimeTalkAgentControl(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void | Promise<void>;
  callId: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    return;
  }
  let result: unknown;
  try {
    const parsed = parseRealtimeVoiceAgentControlToolArgs(params.args);
    result = await requestRealtimeTalkSteer(params.ctx, params.sessionId, parsed.text, parsed.mode);
    if (params.signal?.aborted) {
      return;
    }
  } catch (error) {
    const message = formatUiError(error);
    result = { error: message };
    if (params.signal?.aborted || isAbortError(error)) {
      return;
    }
  }
  await params.submit(params.callId, result);
}

// Owns the consult's abort listener until its acknowledged run and result settle.
export async function submitRealtimeTalkConsult(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void | Promise<void>;
  callId: string;
  relaySessionId?: string;
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
    // Relay lifetimes belong to the Gateway; aborting this browser wait must not cancel them.
    if (run && !params.relaySessionId) {
      void ctx.client
        .request("chat.abort", {
          sessionKey: run.agentSessionKey,
          agentId: run.agentId,
          runId: run.runId,
        })
        .catch(() => undefined);
    }
  };
  if (params.signal?.aborted) {
    await submitAbortResult();
    return;
  }
  const disposeAbort = params.signal && listen(params.signal, "abort", abortRun, { once: true });
  try {
    const args =
      typeof params.args === "string" ? JSON.parse(params.args || "{}") : (params.args ?? {});
    await ctx.flushTranscriptWrites?.();
    if (params.signal?.aborted) {
      await submitAbortResult();
      return;
    }
    // Cancellation must not hide the acknowledgement that owns the Gateway run.
    // Once the run id arrives, direct transports can cancel the exact started consult.
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
    disposeAbort?.();
    if (submissionCompleted && !aborted && !params.signal?.aborted) {
      ctx.callbacks.onStatus?.("listening");
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

export {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  shouldAutoControlRealtimeVoiceAgentText,
};
