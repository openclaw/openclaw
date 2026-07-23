// Gateway Talk realtime relay.
// Bridges browser Talk audio sessions with realtime voice provider plugins.
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  parseRealtimeVoiceAgentConsultArgs,
} from "../talk/agent-consult-tool.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../talk/agent-run-control-shared.js";
import {
  buildRealtimeVoiceAgentControlSpeechMessage,
  controlRealtimeVoiceAgentRun,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlResult,
} from "../talk/agent-run-control.js";
import {
  appendRelayVoiceTranscript,
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../talk/client-voice-session.js";
import { readSpeakableRealtimeVoiceToolResult } from "../talk/consult-question.js";
import type { RealtimeVoiceForcedConsultHandle } from "../talk/forced-consult-coordinator.js";
import {
  createRealtimeVoiceOutputMediaSession,
  type RealtimeVoiceOutputMediaEvent,
  type RealtimeVoiceOutputMediaSession,
} from "../talk/output-media.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBrowserAudioContract,
  type RealtimeVoiceAudioClearReason,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolCallEvent,
  type RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../talk/realtime-session-harness.js";
import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceBridgeSessionParams,
} from "../talk/session-runtime.js";
import type { TalkEvent, TalkEventInput } from "../talk/talk-session-controller.js";
import { abortChatRunById } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import {
  buildTalkRealtimeRelayIssuePayload as relayIssuePayload,
  createTalkRealtimeRelayIssue as realtimeRelayIssue,
} from "./talk-realtime-relay-issues.js";
import { decodeTalkRelayAudioBase64 } from "./talk-relay-audio-base64.js";
import {
  closeExpiredTalkRelaySessions,
  requireActiveTalkRelaySession,
} from "./talk-relay-session-lifecycle.js";
import { forgetUnifiedTalkSession } from "./talk-session-registry.js";
const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const MAX_RELAY_SESSIONS_PER_CONN = 2;
const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_EVENT = "talk.event";
const RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS = 12_000;
const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_RESULT_MAX_CHARS = 1_800;
const noFallbackRelayOutputFlush = () => {};

type TalkRealtimeRelayEventPayload =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "inputAudio"; byteLength: number }
  | {
      relaySessionId: string;
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { relaySessionId: string; type: "audioDone"; itemId?: string; responseId?: string }
  | { relaySessionId: string; type: "clear"; reason?: RealtimeVoiceAudioClearReason }
  | { relaySessionId: string; type: "mark"; markName: string }
  | {
      relaySessionId: string;
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
    }
  | {
      relaySessionId: string;
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { relaySessionId: string; type: "toolResult"; callId: string }
  | { relaySessionId: string; type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | {
      relaySessionId: string;
      type: "error";
      message: string;
      code?: "realtime_unavailable";
      provider?: string;
      model?: string;
      transport?: "gateway-relay";
      phase?: string;
    }
  | { relaySessionId: string; type: "close"; reason: "completed" | "error" };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventPayload & { talkEvent?: TalkEvent };

type ForcedTerminalProviderResult = {
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
  turnId: string;
  epoch: number;
};

type RelayAgentControlProviderSubmission = {
  completion?: Promise<void>;
  providerResponseStarted: boolean;
};

type RelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  harness: RealtimeVoiceSessionHarness<unknown, ManagedAgentConsultMetadata>;
  outputMedia?: RealtimeVoiceOutputMediaSession;
  sessionKey?: string;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, string>;
  provider: string;
  activeAgentToolCalls: Map<string, string>;
  completedAgentToolCalls: Set<string>;
  // Cancelled calls retain their original turn long enough to terminally satisfy
  // late browser results without creating a replacement turn or owner success event.
  cancelledAgentToolCalls: Map<string, string>;
  pendingFinalToolResults: Map<string, Promise<void>>;
  // Provider acceptance survives partial retries independently from the owner-facing
  // agent-call lifecycle, so accepted native ids are never submitted twice.
  completedProviderToolResults: Set<string>;
  pendingProviderToolResults: Map<string, Promise<void>>;
  // A final result must wait until the provider accepts its continuation result;
  // otherwise async bridges can observe final-before-working ordering.
  pendingWorkingToolResults: Map<string, Promise<void>>;
  // Keep a forced terminal result open while late matching native ids join it.
  // Delivery/cancellation closes the state only after every current id accepts.
  forcedTerminalProviderResults: Map<string, ForcedTerminalProviderResult>;
  // Turn cancellation invalidates async acceptance callbacks from the prior turn.
  toolResultEpoch: number;
  voiceConfig?: OpenClawConfig;
  voiceSessionCreated: boolean;
  voiceTranscriptSeq: number;
  voiceTranscriptWrites: Promise<void>;
  pendingVoiceTranscripts: Array<{ role: "user" | "assistant"; text: string }>;
  managedConsultResults: Map<string, string>;
};

type ManagedAgentConsultMetadata = {
  handle: RealtimeVoiceForcedConsultHandle;
  args?: RealtimeVoiceToolCallEvent["args"];
};

type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  cfg?: OpenClawConfig;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions: string;
  tools: RealtimeVoiceTool[];
  model?: string;
  sessionKey?: string;
  voice?: string;
  language?: string;
  manageAgentConsult?: boolean;
  forceAgentConsultOnFinalTranscript?: boolean;
  onOutputMediaEvent?: (event: RealtimeVoiceOutputMediaEvent) => void | Promise<void>;
};

type TalkRealtimeRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt: number;
};

const relaySessions = new Map<string, RelaySession>();
const RELAY_TRANSCRIPT_RETRY_DELAYS_MS = [0, 500, 2_000] as const;

function logRelayVoiceFailure(session: RelaySession, message: string, error: unknown): void {
  session.context.logGateway?.warn(`${message}: ${formatErrorMessage(error)}`);
}

function ensureRelayVoiceSession(session: RelaySession): boolean {
  if (session.voiceSessionCreated) {
    return true;
  }
  if (!session.sessionKey) {
    return false;
  }
  try {
    createOrResumeClientVoiceSession({
      agentId: resolveAgentIdFromSessionKey(session.sessionKey),
      sessionKey: session.sessionKey,
      provider: session.provider,
      origin: "relay",
      voiceSessionId: session.id,
    });
    session.voiceSessionCreated = true;
    return true;
  } catch (error) {
    logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
    return false;
  }
}

const MAX_PENDING_VOICE_TRANSCRIPTS = 40;

function enqueueRelayVoiceTranscript(
  session: RelaySession,
  role: "user" | "assistant",
  text: string,
): void {
  if (!session.sessionKey) {
    // Lazy-bound relays hear audio before talk.client.toolCall supplies the session
    // key; buffer bounded finals so the call's opening turns survive the binding.
    // Never-binding callers accept best-effort loss: they had no persistence before.
    session.pendingVoiceTranscripts.push({ role, text });
    if (session.pendingVoiceTranscripts.length > MAX_PENDING_VOICE_TRANSCRIPTS) {
      session.pendingVoiceTranscripts.shift();
    }
    return;
  }
  if (!ensureRelayVoiceSession(session)) {
    return;
  }
  session.voiceTranscriptSeq += 1;
  const entryId = String(session.voiceTranscriptSeq);
  const sessionKey = session.sessionKey;
  session.voiceTranscriptWrites = session.voiceTranscriptWrites
    .then(async () => {
      let lastError: unknown;
      for (const delayMs of RELAY_TRANSCRIPT_RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        try {
          await appendRelayVoiceTranscript({
            agentId: resolveAgentIdFromSessionKey(sessionKey),
            sessionKey,
            voiceSessionId: session.id,
            entryId,
            role,
            text,
            ...(session.voiceConfig ? { config: session.voiceConfig } : {}),
          });
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })
    .catch((error: unknown) => {
      logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
    });
}

function closeRelayVoiceSession(session: RelaySession): void {
  if (!session.sessionKey || !ensureRelayVoiceSession(session)) {
    return;
  }
  const sessionKey = session.sessionKey;
  void session.voiceTranscriptWrites
    .then(async () => {
      const config = session.voiceConfig ?? session.context.getRuntimeConfig();
      await closeClientVoiceSession({
        agentId: resolveAgentIdFromSessionKey(sessionKey),
        sessionKey,
        voiceSessionId: session.id,
        config,
      });
    })
    .catch((error: unknown) => {
      logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
    });
}

/** Ensure a gateway-relay call has its durable record before transcript-free RPCs. */
export function ensureTalkRealtimeRelayVoiceSession(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.sessionKey && session.sessionKey !== params.sessionKey) {
    throw new Error("Realtime relay session belongs to another agent session");
  }
  session.sessionKey = params.sessionKey;
  if (!ensureRelayVoiceSession(session)) {
    throw new Error("Realtime relay voice session could not be created");
  }
  const buffered = session.pendingVoiceTranscripts.splice(0);
  for (const entry of buffered) {
    enqueueRelayVoiceTranscript(session, entry.role, entry.text);
  }
}

let gatewayAgentConsultRuntimePromise:
  | Promise<typeof import("./talk-managed-agent-consult.runtime.js")>
  | undefined;

function resolveGatewayAgentConsultRuntime() {
  gatewayAgentConsultRuntimePromise ??= import("./talk-managed-agent-consult.runtime.js");
  return gatewayAgentConsultRuntimePromise;
}

function isWorkingToolResult(result: unknown): boolean {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).status === "working"
  );
}

function isRelayAssistantEchoTranscript(session: RelaySession | undefined, text: string): boolean {
  return session?.harness.isLikelyAssistantEchoTranscript(text) ?? false;
}
function buildForcedConsultCheckingPrompt(): string {
  return [
    "Briefly tell the person that you are checking with OpenClaw.",
    "Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
  ].join(" ");
}

function buildForcedConsultSpeechPrompt(text: string): string {
  return [
    "OpenClaw finished checking. Speak this result naturally and concisely.",
    "Do not mention tool calls, JSON, or internal routing.",
    "",
    text,
  ].join("\n");
}

function buildAlreadyDeliveredToolResult(): Record<string, string> {
  return {
    status: "already_delivered",
    message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
  };
}

function suppressedToolResultOptions(
  session: RelaySession,
): RealtimeVoiceToolResultOptions | undefined {
  return session.bridge.bridge.supportsToolResultSuppression === false
    ? undefined
    : { suppressResponse: true };
}

function cancelForcedConsults(session: RelaySession): void {
  for (const handle of session.harness.forcedConsults.handles()) {
    session.harness.forcedConsults.markCancelled(handle);
  }
}

function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
  options: { dropIfSlow?: boolean } = { dropIfSlow: true },
): void {
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), options);
}

function relayEventDeliveryOptions(event: TalkRealtimeRelayEventPayload): { dropIfSlow?: boolean } {
  switch (event.type) {
    case "ready":
    case "error":
    case "close":
    case "mark":
      return { dropIfSlow: false };
    default:
      return { dropIfSlow: true };
  }
}

function abortRelayAgentRuns(session: RelaySession, reason: string): void {
  for (const [runId, sessionKey] of session.activeAgentRuns) {
    abortChatRunById(session.context, {
      runId,
      sessionKey,
      stopReason: reason,
    });
  }
  session.activeAgentRuns.clear();
  session.activeAgentToolCalls.clear();
}

function pruneInactiveRelayAgentRuns(session: RelaySession): number {
  for (const runId of session.activeAgentRuns.keys()) {
    if (!session.context.chatAbortControllers.has(runId)) {
      session.activeAgentRuns.delete(runId);
    }
  }
  for (const [callId, runId] of session.activeAgentToolCalls) {
    if (!session.activeAgentRuns.has(runId)) {
      session.activeAgentToolCalls.delete(callId);
    }
  }
  return session.activeAgentRuns.size;
}

function broadcastToolResultToOwner(
  session: RelaySession,
  params: {
    callId: string;
    turnId: string;
    result: unknown;
    final: boolean;
    forced?: boolean;
  },
): void {
  const payload =
    params.forced === true ? { result: params.result, forced: true } : { result: params.result };
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId: params.callId,
    talkEvent: session.harness.talk.emit({
      type: "tool.result",
      callId: params.callId,
      turnId: params.turnId,
      payload,
      final: params.final,
    }),
  });
}

function completeAfterToolResultSubmissions(
  session: RelaySession,
  submissions: Array<void | Promise<void>>,
  onAccepted: () => void,
): void | Promise<void> {
  const pending = submissions.filter(
    (submission): submission is Promise<void> => submission !== undefined,
  );
  const complete = () => {
    if (relaySessions.get(session.id) === session) {
      onAccepted();
    }
  };
  if (pending.length === 0) {
    complete();
    return;
  }
  return Promise.all(pending).then(complete);
}

function submitFinalProviderToolResult(params: {
  session: RelaySession;
  callId: string;
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
  onAccepted?: () => void;
}): void | Promise<void> {
  if (params.session.completedProviderToolResults.has(params.callId)) {
    if (relaySessions.get(params.session.id) === params.session) {
      params.onAccepted?.();
    }
    return;
  }
  const pending = params.session.pendingProviderToolResults.get(params.callId);
  if (pending) {
    return pending;
  }
  const submit = () =>
    params.session.bridge.submitToolResult(params.callId, params.result, params.options);
  const working = params.session.pendingWorkingToolResults.get(params.callId);
  const epoch = params.session.toolResultEpoch;
  const submitAfterWorking = async () => {
    if (relaySessions.get(params.session.id) !== params.session) {
      return false;
    }
    if (params.session.toolResultEpoch !== epoch) {
      if (!params.session.cancelledAgentToolCalls.has(params.callId)) {
        return false;
      }
      // The browser already considers this final submitted while it waits behind
      // the provider's working-result acknowledgement. Finish the cancelled call
      // here so the provider is not left waiting for a terminal result.
      await params.session.bridge.submitToolResult(
        params.callId,
        buildRealtimeVoiceAgentCancelProviderResult(
          "OpenClaw cancelled this consult before completion. Do not restart it.",
        ),
        suppressedToolResultOptions(params.session),
      );
      params.session.completedProviderToolResults.add(params.callId);
      params.session.cancelledAgentToolCalls.delete(params.callId);
      params.session.completedAgentToolCalls.add(params.callId);
      return false;
    }
    await submit();
    return true;
  };
  const submission = working ? working.then(submitAfterWorking, submitAfterWorking) : submit();
  const accept = () => {
    params.session.completedProviderToolResults.add(params.callId);
    if (relaySessions.get(params.session.id) === params.session) {
      params.onAccepted?.();
    }
  };
  if (!submission) {
    accept();
    return;
  }
  const tracked = submission
    .then((submitted) => {
      if (submitted !== false) {
        accept();
      }
    })
    .finally(() => {
      if (params.session.pendingProviderToolResults.get(params.callId) === tracked) {
        params.session.pendingProviderToolResults.delete(params.callId);
      }
    });
  params.session.pendingProviderToolResults.set(params.callId, tracked);
  return tracked;
}

function trackAgentFinalToolResult(
  session: RelaySession,
  callId: string,
  completion: void | Promise<void>,
): void | Promise<void> {
  if (!completion) {
    return;
  }
  const tracked = completion.finally(() => {
    if (session.pendingFinalToolResults.get(callId) === tracked) {
      session.pendingFinalToolResults.delete(callId);
    }
  });
  session.pendingFinalToolResults.set(callId, tracked);
  return tracked;
}

function trackPendingWorkingToolResult(
  session: RelaySession,
  callId: string,
  completion: void | Promise<void>,
): void | Promise<void> {
  if (!completion) {
    return;
  }
  const tracked = completion.finally(() => {
    if (session.pendingWorkingToolResults.get(callId) === tracked) {
      session.pendingWorkingToolResults.delete(callId);
    }
  });
  session.pendingWorkingToolResults.set(callId, tracked);
  return tracked;
}

function clearRelayAgentToolCall(session: RelaySession, callId: string): void {
  const runId = session.activeAgentToolCalls.get(callId);
  session.activeAgentToolCalls.delete(callId);
  if (!runId) {
    return;
  }
  const runStillActive = [...session.activeAgentToolCalls.values()].includes(runId);
  if (!runStillActive) {
    session.activeAgentRuns.delete(runId);
  }
}

function submitRelayAgentControlProviderResults(
  session: RelaySession,
  result: RealtimeVoiceAgentControlResult,
  turnId: string,
): RelayAgentControlProviderSubmission | undefined {
  if (result.mode !== "cancel" || !result.ok || !result.providerResult) {
    return undefined;
  }
  const providerResult = result.providerResult;
  const epoch = session.toolResultEpoch;
  const callIds = [...session.activeAgentToolCalls.keys()];
  const activeCallIds = callIds.filter((callId) => !session.pendingFinalToolResults.has(callId));
  const submissions: Array<void | Promise<void>> = callIds
    .map((callId) => session.pendingFinalToolResults.get(callId))
    .filter((pending): pending is Promise<void> => pending !== undefined);
  const toolResultOptions = suppressedToolResultOptions(session);
  let providerResponseStarted = toolResultOptions === undefined && submissions.length > 0;
  const finalizeAgentCall = (callId: string, forcedConsult?: RealtimeVoiceForcedConsultHandle) => {
    if (session.toolResultEpoch !== epoch) {
      return;
    }
    if (forcedConsult) {
      session.harness.forcedConsults.markCancelled(forcedConsult);
    }
    broadcastToolResultToOwner(session, {
      callId,
      turnId,
      result: providerResult,
      final: true,
    });
    clearRelayAgentToolCall(session, callId);
    session.completedAgentToolCalls.add(callId);
  };
  for (const callId of activeCallIds) {
    const forcedConsult = session.harness.forcedConsults
      .handles()
      .find((handle) => handle.id === callId);
    if (forcedConsult) {
      const nativeCallIds = session.harness.forcedConsults.nativeCallIds(forcedConsult);
      providerResponseStarted ||= toolResultOptions === undefined && nativeCallIds.length > 0;
      const terminal: ForcedTerminalProviderResult = {
        result: providerResult,
        options: toolResultOptions,
        turnId,
        epoch,
      };
      session.forcedTerminalProviderResults.set(callId, terminal);
      const clearTerminal = () => {
        if (session.forcedTerminalProviderResults.get(callId) === terminal) {
          session.forcedTerminalProviderResults.delete(callId);
        }
      };
      const drained = drainForcedTerminalProviderResultsAfterPending(
        session,
        forcedConsult,
        terminal,
      );
      const completed = completeAfterToolResultSubmissions(session, [drained], () => {
        clearTerminal();
        finalizeAgentCall(callId, forcedConsult);
      });
      const tracked = trackAgentFinalToolResult(session, callId, completed?.finally(clearTerminal));
      submissions.push(tracked);
      continue;
    }
    providerResponseStarted ||= toolResultOptions === undefined;
    const submitted = submitFinalProviderToolResult({
      session,
      callId,
      result: providerResult,
      options: toolResultOptions,
      onAccepted: () => finalizeAgentCall(callId),
    });
    submissions.push(trackAgentFinalToolResult(session, callId, submitted));
  }
  const completion = completeAfterToolResultSubmissions(session, submissions, () => {});
  return {
    ...(completion ? { completion } : {}),
    providerResponseStarted,
  };
}

function closeRelaySession(session: RelaySession, reason: "completed" | "error"): void {
  session.harness.close();
  relaySessions.delete(session.id);
  forgetUnifiedTalkSession(session.id);
  clearTimeout(session.cleanupTimer);
  abortRelayAgentRuns(session, reason === "error" ? "relay-error" : "relay-closed");
  session.bridge.close();
  closeRelayVoiceSession(session);
  session.outputMedia?.end(reason);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "close",
    reason,
    talkEvent: session.harness.talk.emit({
      type: "session.closed",
      payload: { reason },
      final: true,
    }),
  });
}

function pruneExpiredRelaySessions(nowMs = Date.now()): void {
  closeExpiredTalkRelaySessions({
    sessions: relaySessions.values(),
    closeSession: (session) => closeRelaySession(session, "completed"),
    nowMs,
  });
}

function countRelaySessionsForConn(connId: string): number {
  let count = 0;
  for (const session of relaySessions.values()) {
    if (session.connId === connId) {
      count += 1;
    }
  }
  return count;
}

function enforceRelaySessionLimits(connId: string): void {
  pruneExpiredRelaySessions();
  if (relaySessions.size >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error("Too many active realtime relay sessions");
  }
  if (countRelaySessionsForConn(connId) >= MAX_RELAY_SESSIONS_PER_CONN) {
    throw new Error("Too many active realtime relay sessions for this connection");
  }
}

/** Creates a realtime voice relay session and returns the browser audio contract. */
export function createTalkRealtimeRelaySession(
  params: CreateTalkRealtimeRelaySessionParams,
): TalkRealtimeRelaySessionResult {
  enforceRelaySessionLimits(params.connId);
  const manageAgentConsult = params.manageAgentConsult === true;
  if (manageAgentConsult && !params.sessionKey?.trim()) {
    throw new Error("Gateway-owned realtime agent consult requires a session key");
  }
  const forceAgentConsultOnFinalTranscript = params.forceAgentConsultOnFinalTranscript === true;
  const relaySessionId = randomUUID();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(RELAY_SESSION_TTL_MS);
  if (expiresAtMs === undefined) {
    throw new Error("Realtime relay session expiry is outside the supported Date range");
  }
  const relayRef: { current?: RelaySession } = {};
  const requesterSessionKey = params.sessionKey?.trim() ?? "";
  const managedAgentId = manageAgentConsult
    ? resolveAgentIdFromSessionKey(requesterSessionKey)
    : undefined;
  const harness = createRealtimeVoiceSessionHarness<unknown, ManagedAgentConsultMetadata>({
    talk: {
      sessionId: relaySessionId,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: params.provider.id,
      // Keep the pre-harness steering window; other harness consumers use the shared default.
      maxRecentEvents: 20,
    },
    talkPayloads: {
      turnStarted: () => ({}),
      turnEnded: (reason) => ({ reason }),
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => ({}),
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: (reason, details) =>
        details?.markName ? { markName: details.markName } : { reason },
    },
    transcriptLookbackMs: RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
    captureBridgeEvents: false,
    ...(manageAgentConsult && managedAgentId
      ? {
          talkback: {
            debounceMs: 120,
            logger: params.context.logGateway,
            logPrefix: `[talk:${relaySessionId}] gateway agent`,
            responseStyle: "Brief, natural spoken answer for a live voice conversation.",
            fallbackText: "I hit an error while checking that. Please try again.",
            consult: async ({ question, responseStyle, metadata }) => {
              const relay = relayRef.current;
              if (!relay) {
                throw new Error("Realtime Talk session closed before the agent consult started");
              }
              const runtime = await resolveGatewayAgentConsultRuntime();
              const toolArgs = metadata?.args ?? { question, responseStyle };
              return await runtime.consultTalkManagedAgent({
                cfg: params.cfg ?? params.context.getRuntimeConfig(),
                logger: params.context.logGateway,
                agentId: managedAgentId,
                sessionKey: requesterSessionKey,
                messageProvider: "talk",
                lane: "talk",
                runIdPrefix: `talk:${relaySessionId}`,
                onRunStarted: (runId) =>
                  registerTalkRealtimeRelayAgentRun({
                    relaySessionId,
                    connId: params.connId,
                    sessionKey: requesterSessionKey,
                    runId,
                  }),
                args: toolArgs,
                transcript: relay.harness.transcript,
                surface: "OpenClaw realtime Talk",
                userLabel: "person",
                assistantLabel: "voice assistant",
                questionSourceLabel: "live microphone",
                extraSystemPrompt:
                  "You are the configured OpenClaw agent receiving a request from a realtime Talk session. Use the OpenClaw workspace and available tools when appropriate, complete the requested work, and return a concise result suitable for speech.",
              });
            },
            deliver: (text, metadata) => {
              const relay = relayRef.current;
              if (!relay || relaySessions.get(relaySessionId) !== relay) {
                return;
              }
              const handle = metadata?.handle;
              const callIds = handle ? relay.harness.forcedConsults.nativeCallIds(handle) : [];
              if (handle) {
                relay.managedConsultResults.set(handle.id, text);
                while (relay.managedConsultResults.size > 12) {
                  const oldest = relay.managedConsultResults.keys().next().value;
                  if (!oldest) {
                    break;
                  }
                  relay.managedConsultResults.delete(oldest);
                }
              }
              if (callIds.length === 0) {
                relay.bridge.sendUserMessage(buildForcedConsultSpeechPrompt(text));
                if (handle) {
                  relay.harness.forcedConsults.markDelivered(handle);
                }
                return;
              }
              void Promise.all(
                callIds.map((callId) =>
                  Promise.resolve(
                    submitTalkRealtimeRelayToolResult({
                      relaySessionId,
                      connId: params.connId,
                      callId,
                      result: { text },
                    }),
                  ),
                ),
              )
                .then(() => {
                  if (handle) {
                    relay.harness.forcedConsults.markDelivered(handle);
                  }
                })
                .catch((error: unknown) => {
                  params.context.logGateway.warn(
                    `[talk:${relaySessionId}] managed consult result failed: ${formatErrorMessage(error)}`,
                  );
                });
            },
          },
        }
      : {}),
  });
  const outputMedia = params.onOutputMediaEvent
    ? createRealtimeVoiceOutputMediaSession({ onEvent: params.onOutputMediaEvent })
    : undefined;
  const broadcastEvent = (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEvent) =>
    broadcastToOwner(
      params.context,
      params.connId,
      {
        ...event,
        ...(talkEvent ? { talkEvent } : {}),
      },
      relayEventDeliveryOptions(event),
    );
  const emit = (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEventInput) =>
    broadcastEvent(event, talkEvent ? harness.emit(talkEvent) : undefined);
  let currentOutputItemId: string | undefined;
  let currentOutputResponseId: string | undefined;
  let ready = false;
  let failureEmitted = false;
  const bridgeParams: RealtimeVoiceBridgeSessionParams = {
    provider: params.provider,
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    language: params.language,
    autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
    interruptResponseOnInputAudio: manageAgentConsult || !forceAgentConsultOnFinalTranscript,
    tools: params.tools,
    markStrategy: "transport",
    audioSink: {
      isOpen: () => Boolean(relayRef.current && relaySessions.has(relayRef.current.id)),
      sendAudio: (audio) => {
        const relay = relayRef.current;
        const recorded = relay?.harness.appendOutputAudio(audio);
        if (relay) {
          broadcastRelayTurnStarted(relay, recorded?.turn.event);
        }
        broadcastEvent(
          {
            relaySessionId,
            type: "audio",
            audioBase64: audio.toString("base64"),
            ...(currentOutputItemId ? { itemId: currentOutputItemId } : {}),
            ...(currentOutputResponseId ? { responseId: currentOutputResponseId } : {}),
          },
          recorded?.outputAudioDelta,
        );
        outputMedia?.sendAudio(audio);
      },
      clearAudio: (reason) => {
        const talkEvent = relayRef.current?.harness.completeOutputAudio(reason ?? "clear");
        broadcastEvent({ relaySessionId, type: "clear", ...(reason ? { reason } : {}) }, talkEvent);
        outputMedia?.clear(reason ?? "cancel");
        outputMedia?.setState("listening");
      },
      sendMark: (markName) => {
        const talkEvent = relayRef.current?.harness.completeOutputAudio("mark", { markName });
        broadcastEvent({ relaySessionId, type: "mark", markName }, talkEvent);
      },
    },
    onEvent: (event) => {
      if (event.direction !== "server") {
        return;
      }
      if (event.type === "input_audio_buffer.speech_started") {
        outputMedia?.setState("listening");
      } else if (
        event.type === "input_audio_buffer.speech_stopped" ||
        event.type === "input_audio_buffer.committed" ||
        event.type === "response.created"
      ) {
        outputMedia?.setState("thinking");
      }
      if (
        event.type === "conversation.output_audio.delta" ||
        event.type === "response.audio.delta" ||
        event.type === "response.output_audio.delta"
      ) {
        currentOutputItemId = event.itemId ?? currentOutputItemId;
        currentOutputResponseId = event.responseId ?? currentOutputResponseId;
        return;
      }
      if (
        event.type === "response.audio.done" ||
        event.type === "response.output_audio.done" ||
        event.type === "conversation.output_audio.done" ||
        event.type === "response.done" ||
        event.type === "response.cancelled"
      ) {
        outputMedia?.setState("listening");
        broadcastEvent(
          {
            relaySessionId,
            type: "audioDone",
            ...((event.itemId ?? currentOutputItemId)
              ? { itemId: event.itemId ?? currentOutputItemId }
              : {}),
            ...((event.responseId ?? currentOutputResponseId)
              ? { responseId: event.responseId ?? currentOutputResponseId }
              : {}),
          },
          relayRef.current?.harness.completeOutputAudio(event.type),
        );
        currentOutputItemId = undefined;
        currentOutputResponseId = undefined;
      }
    },
    onTranscript: (role, text, final) => {
      const relay = relayRef.current;
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      if (final && relay) {
        enqueueRelayVoiceTranscript(relay, role, text);
      }
      const eventType =
        role === "assistant"
          ? final
            ? "output.text.done"
            : "output.text.delta"
          : final
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emit(
        { relaySessionId, type: "transcript", role, text, final },
        {
          type: eventType,
          turnId,
          payload,
          final,
        },
      );
      if (role === "user" && final && text.trim()) {
        const question = text.trim();
        if (isRelayAssistantEchoTranscript(relay, question)) {
          return;
        }
        if (
          relay &&
          pruneInactiveRelayAgentRuns(relay) > 0 &&
          shouldAutoControlRealtimeVoiceAgentText(question)
        ) {
          // While an agent consult is active, short user utterances like "stop"
          // steer the chat run instead of becoming a new consult.
          void steerTalkRealtimeRelayAgentRun({
            relaySessionId,
            connId: params.connId,
            text: question,
          })
            .then((result) => {
              if (result.speak && !result.suppress && result.message.trim()) {
                bridge.sendUserMessage(buildRealtimeVoiceAgentControlSpeechMessage(result.message));
              }
            })
            .catch((error: unknown) => {
              emit(
                { relaySessionId, type: "error", message: formatErrorMessage(error) },
                {
                  type: "session.error",
                  payload: { message: formatErrorMessage(error) },
                  final: true,
                },
              );
            });
          return;
        }
        if (manageAgentConsult && forceAgentConsultOnFinalTranscript) {
          if (!relay) {
            return;
          }
          if (relay.harness.forcedConsults.hasRecent(question)) {
            return;
          }
          relay.harness.forcedConsults.clearPending();
          const handle = relay.harness.forcedConsults.prepare(question);
          if (handle) {
            relay.harness.forcedConsults.schedule(handle, FORCED_CONSULT_FALLBACK_DELAY_MS, () => {
              relay.harness.forcedConsults.markStarted(handle);
              runOutsideGatewayRootWorkAdmission(() =>
                relay.harness.talkback?.enqueue(question, { handle }),
              );
            });
          }
        } else if (forceAgentConsultOnFinalTranscript) {
          scheduleForcedAgentConsult(relay, question);
        }
      }
    },
    onToolCall: (toolCall) => {
      const relay = relayRef.current;
      if (relay && manageAgentConsult && toolCall.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        const parsed = parseRealtimeVoiceAgentConsultArgs(toolCall.args);
        let match = relay.harness.forcedConsults.recordNativeConsult(
          toolCall.args,
          toolCall.callId,
        );
        let handle = match.kind === "none" ? undefined : match.handle;
        if (!handle) {
          handle = relay.harness.forcedConsults.prepare(parsed.question);
          if (handle) {
            match = relay.harness.forcedConsults.recordNativeConsult(
              toolCall.args,
              toolCall.callId,
            );
          }
        }
        const working = submitRealtimeAgentConsultWorkingResponse(
          relay,
          toolCall.callId,
          ensureRelayTurn(relay),
        );
        if (!handle) {
          return working;
        }
        if (match.kind === "already_delivered") {
          const text = relay.managedConsultResults.get(handle.id);
          if (text) {
            void Promise.resolve(working).then(() =>
              submitTalkRealtimeRelayToolResult({
                relaySessionId,
                connId: params.connId,
                callId: toolCall.callId,
                result: { text },
              }),
            );
          }
          return working;
        }
        if (match.kind !== "in_flight") {
          relay.harness.forcedConsults.markStarted(handle);
          runOutsideGatewayRootWorkAdmission(() =>
            relay.harness.talkback?.enqueue(parsed.question, { handle, args: toolCall.args }),
          );
        }
        return working;
      }
      let shouldSubmitWorkingResult = false;
      if (relay && toolCall.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        const forcedConsult = relay.harness.forcedConsults.recordNativeConsult(
          toolCall.args,
          toolCall.callId,
        );
        if (forcedConsult.kind === "in_flight" || forcedConsult.kind === "already_delivered") {
          if (forcedConsult.kind === "already_delivered") {
            const result = relay.harness.forcedConsults.isCancelled(forcedConsult.handle)
              ? buildRealtimeVoiceAgentCancelProviderResult(
                  "OpenClaw cancelled this consult before completion. Do not restart it.",
                )
              : buildAlreadyDeliveredToolResult();
            return submitForcedConsultProviderResult(
              relay,
              toolCall.callId,
              result,
              suppressedToolResultOptions(relay),
            );
          }
          if (relay.forcedTerminalProviderResults.has(forcedConsult.handle.id)) {
            return relay.pendingFinalToolResults.get(forcedConsult.handle.id);
          }
          return submitRealtimeAgentConsultWorkingResponse(relay, toolCall.callId);
        }
        shouldSubmitWorkingResult = true;
      }
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      emit(
        {
          relaySessionId,
          type: "toolCall",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          name: toolCall.name,
          args: toolCall.args,
        },
        {
          type: "tool.call",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          turnId,
          payload: { name: toolCall.name, args: toolCall.args },
        },
      );
      if (relay && shouldSubmitWorkingResult) {
        return submitRealtimeAgentConsultWorkingResponse(relay, toolCall.callId, turnId);
      }
    },
    onReady: () => {
      ready = true;
      emit({ relaySessionId, type: "ready" }, { type: "session.ready", payload: null });
      outputMedia?.setState("listening");
    },
    onError: (error) => {
      const issue = realtimeRelayIssue({
        message: formatErrorMessage(error),
        provider: params.provider.id,
        model: params.model,
        phase: ready ? "stream" : "connect",
      });
      failureEmitted = true;
      emit(relayIssuePayload(relaySessionId, issue), {
        type: "session.error",
        payload: issue,
        final: true,
      });
      outputMedia?.setState(ready ? "listening" : "error");
    },
    onClose: (reason) => {
      const active = relaySessions.get(relaySessionId);
      if (!active) {
        return;
      }
      active.harness.close();
      relaySessions.delete(relaySessionId);
      forgetUnifiedTalkSession(relaySessionId);
      clearTimeout(active.cleanupTimer);
      abortRelayAgentRuns(active, "relay-closed");
      closeRelayVoiceSession(active);
      active.outputMedia?.end(reason);
      if (!ready && !failureEmitted) {
        const issue = realtimeRelayIssue({
          message: "Realtime provider closed before the session became ready.",
          provider: params.provider.id,
          model: params.model,
          phase: "connect",
        });
        emit(relayIssuePayload(relaySessionId, issue), {
          type: "session.error",
          payload: issue,
          final: true,
        });
      }
      emit(
        { relaySessionId, type: "close", reason },
        { type: "session.closed", payload: { reason }, final: true },
      );
    },
  };
  let bridge: RealtimeVoiceBridgeSession;
  try {
    bridge = harness.createBridge(bridgeParams);
  } catch (error) {
    harness.close();
    outputMedia?.end("error");
    throw error;
  }
  const relay: RelaySession = {
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    harness,
    ...(outputMedia ? { outputMedia } : {}),
    sessionKey: params.sessionKey?.trim() || undefined,
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = relaySessions.get(relaySessionId);
      if (active) {
        closeRelaySession(active, "completed");
      }
    }, RELAY_SESSION_TTL_MS),
    activeAgentRuns: new Map(),
    provider: params.provider.id,
    activeAgentToolCalls: new Map(),
    completedAgentToolCalls: new Set(),
    cancelledAgentToolCalls: new Map(),
    pendingFinalToolResults: new Map(),
    completedProviderToolResults: new Set(),
    pendingProviderToolResults: new Map(),
    pendingWorkingToolResults: new Map(),
    forcedTerminalProviderResults: new Map(),
    toolResultEpoch: 0,
    ...(params.cfg ? { voiceConfig: params.cfg } : {}),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptWrites: Promise.resolve(),
    pendingVoiceTranscripts: [],
    managedConsultResults: new Map(),
  };
  relayRef.current = relay;
  relay.cleanupTimer.unref?.();
  relaySessions.set(relaySessionId, relay);
  bridge.connect().catch((error: unknown) => {
    const issue = realtimeRelayIssue({
      message: formatErrorMessage(error),
      provider: params.provider.id,
      model: params.model,
      phase: "connect",
    });
    failureEmitted = true;
    emit(relayIssuePayload(relaySessionId, issue), {
      type: "session.error",
      payload: issue,
      final: true,
    });
    const active = relaySessions.get(relaySessionId);
    if (active) {
      closeRelaySession(active, "error");
    }
  });

  return {
    provider: params.provider.id,
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      outputEncoding: "pcm16",
      outputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    },
    ...(params.model ? { model: params.model } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}

function scheduleForcedAgentConsult(session: RelaySession | undefined, question: string): void {
  if (!session || !question.trim()) {
    return;
  }
  if (session.harness.forcedConsults.hasRecentNativeConsult(question)) {
    return;
  }
  session.harness.forcedConsults.clearPending();
  const handle = session.harness.forcedConsults.prepare(question);
  if (!handle) {
    return;
  }
  session.harness.forcedConsults.schedule(handle, FORCED_CONSULT_FALLBACK_DELAY_MS, () => {
    if (!relaySessions.has(session.id)) {
      return;
    }
    const turnId = ensureRelayTurn(session);
    const callId = handle.id;
    const itemId = `forced-consult-item-${randomUUID()}`;
    session.harness.forcedConsults.markStarted(handle);
    session.harness.handleBargeIn(
      { audioPlaybackActive: true, force: true },
      noFallbackRelayOutputFlush,
    );
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "toolCall",
      itemId,
      callId,
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      forced: true,
      args: {
        question: handle.question,
        context:
          "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult for realtime Talk.",
        responseStyle: "Reply in a concise spoken tone.",
      },
      talkEvent: session.harness.talk.emit({
        type: "tool.call",
        itemId,
        callId,
        turnId,
        payload: {
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          args: { question: handle.question },
          forced: true,
        },
      }),
    });
  });
}

function submitForcedConsultProviderResult(
  session: RelaySession,
  callId: string,
  result: unknown,
  options: RealtimeVoiceToolResultOptions | undefined,
): void | Promise<void> {
  return submitFinalProviderToolResult({
    session,
    callId,
    result,
    options,
  });
}

function drainForcedTerminalProviderResults(
  session: RelaySession,
  handle: RealtimeVoiceForcedConsultHandle,
  terminal: ForcedTerminalProviderResult,
): void | Promise<void> {
  if (session.forcedTerminalProviderResults.get(handle.id) !== terminal) {
    return;
  }
  const submissions = session.harness.forcedConsults
    .nativeCallIds(handle)
    .map((callId) =>
      submitForcedConsultProviderResult(session, callId, terminal.result, terminal.options),
    );
  const pending = submissions.filter(
    (submission): submission is Promise<void> => submission !== undefined,
  );
  if (pending.length > 0) {
    return Promise.all(pending).then(() =>
      drainForcedTerminalProviderResults(session, handle, terminal),
    );
  }
  const hasUnsubmittedCall = session.harness.forcedConsults
    .nativeCallIds(handle)
    .some((callId) => !session.completedProviderToolResults.has(callId));
  if (hasUnsubmittedCall) {
    return drainForcedTerminalProviderResults(session, handle, terminal);
  }
}

function drainForcedTerminalProviderResultsAfterPending(
  session: RelaySession,
  handle: RealtimeVoiceForcedConsultHandle,
  terminal: ForcedTerminalProviderResult,
): void | Promise<void> {
  const pending = session.harness.forcedConsults
    .nativeCallIds(handle)
    .map((callId) => session.pendingProviderToolResults.get(callId))
    .filter((submission): submission is Promise<void> => submission !== undefined);
  if (pending.length === 0) {
    return drainForcedTerminalProviderResults(session, handle, terminal);
  }
  return Promise.allSettled(pending).then(() =>
    drainForcedTerminalProviderResults(session, handle, terminal),
  );
}

function submitRealtimeAgentConsultWorkingResponse(
  session: RelaySession,
  callId: string,
  turnId = ensureRelayTurn(session),
): void | Promise<void> {
  if (!session.bridge.bridge.supportsToolResultContinuation) {
    return;
  }
  const epoch = session.toolResultEpoch;
  const submission = session.bridge.submitToolResult(
    callId,
    buildRealtimeVoiceAgentConsultWorkingResponse("person"),
    { willContinue: true },
  );
  const completion = completeAfterToolResultSubmissions(session, [submission], () => {
    if (session.toolResultEpoch !== epoch) {
      return;
    }
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "toolResult",
      callId,
      talkEvent: session.harness.talk.emit({
        type: "tool.progress",
        callId,
        turnId,
        payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: "working" },
      }),
    });
  });
  return trackPendingWorkingToolResult(session, callId, completion);
}

function ensureRelayTurn(session: RelaySession): string {
  const turn = session.harness.ensureActiveTurn();
  broadcastRelayTurnStarted(session, turn.event);
  return turn.turnId;
}

function broadcastRelayTurnStarted(session: RelaySession, event: TalkEvent | undefined): void {
  if (!event) {
    return;
  }
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "inputAudio",
    byteLength: 0,
    talkEvent: event,
  });
}

function getRelaySession(relaySessionId: string, connId: string): RelaySession {
  return requireActiveTalkRelaySession({
    sessions: relaySessions,
    sessionId: relaySessionId,
    connId,
    closeSession: (session) => closeRelaySession(session, "completed"),
    unknownSessionMessage: "Unknown realtime relay session",
  });
}

/** Streams one base64-encoded browser audio frame into the owning relay. */
export function sendTalkRealtimeRelayAudio(params: {
  relaySessionId: string;
  connId: string;
  audioBase64: string;
  timestamp?: number;
}): void {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Realtime relay audio frame is too large");
  }
  const session = getRelaySession(params.relaySessionId, params.connId);
  const audio = decodeTalkRelayAudioBase64(params.audioBase64, "Realtime relay");
  const recorded = session.harness.acceptInputAudio(audio);
  if (!recorded) {
    return;
  }
  broadcastRelayTurnStarted(session, recorded.turn.event);
  session.bridge.sendAudio(audio);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "inputAudio",
    byteLength: audio.byteLength,
    talkEvent: recorded.inputAudioDelta,
  });
  if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) {
    session.bridge.setMediaTimestamp(params.timestamp);
  }
}

/** Confirms that an owning relay client finished playing through a provider mark. */
export function acknowledgeTalkRealtimeRelayMark(params: {
  relaySessionId: string;
  connId: string;
  markName: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.bridge.acknowledgeMark(params.markName);
}

/** Delivers a tool result from the browser/client side back to the provider. */
export function submitTalkRealtimeRelayToolResult(params: {
  relaySessionId: string;
  connId: string;
  callId: string;
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
}): void | Promise<void> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.completedAgentToolCalls.has(params.callId)) {
    return;
  }
  const pendingFinal = session.pendingFinalToolResults.get(params.callId);
  const cancelledAgentCall = session.cancelledAgentToolCalls.has(params.callId);
  if (pendingFinal && !cancelledAgentCall) {
    return pendingFinal;
  }
  const forcedConsult = session.harness.forcedConsults
    .handles()
    .find((handle) => handle.id === params.callId);
  if (forcedConsult) {
    const cancelled = session.harness.forcedConsults.isCancelled(forcedConsult);
    const turnId = cancelled
      ? (session.cancelledAgentToolCalls.get(params.callId) ?? session.harness.talk.activeTurnId)
      : ensureRelayTurn(session);
    if (!turnId) {
      throw new Error("Cancelled realtime consult is missing its original turn");
    }
    if (cancelled) {
      const providerResult = buildRealtimeVoiceAgentCancelProviderResult(
        "OpenClaw cancelled this consult before completion. Do not restart it.",
      );
      const terminal: ForcedTerminalProviderResult = {
        result: providerResult,
        options: suppressedToolResultOptions(session),
        turnId,
        epoch: session.toolResultEpoch,
      };
      session.forcedTerminalProviderResults.set(forcedConsult.id, terminal);
      const clearTerminal = () => {
        if (session.forcedTerminalProviderResults.get(forcedConsult.id) === terminal) {
          session.forcedTerminalProviderResults.delete(forcedConsult.id);
        }
      };
      const drained = drainForcedTerminalProviderResultsAfterPending(
        session,
        forcedConsult,
        terminal,
      );
      const completion = completeAfterToolResultSubmissions(session, [drained], () => {
        clearTerminal();
        if (session.toolResultEpoch !== terminal.epoch) {
          return;
        }
        session.harness.forcedConsults.markCancelled(forcedConsult);
        clearRelayAgentToolCall(session, params.callId);
        session.cancelledAgentToolCalls.delete(params.callId);
        session.completedAgentToolCalls.add(params.callId);
        broadcastToolResultToOwner(session, {
          callId: params.callId,
          turnId,
          result: providerResult,
          forced: true,
          final: true,
        });
      });
      return trackAgentFinalToolResult(session, params.callId, completion?.finally(clearTerminal));
    }
    const final = params.options?.willContinue !== true;
    if (!final) {
      if (isWorkingToolResult(params.result)) {
        session.bridge.sendUserMessage(buildForcedConsultCheckingPrompt());
      }
      broadcastToolResultToOwner(session, {
        callId: params.callId,
        turnId,
        result: params.result,
        forced: true,
        final: false,
      });
      return;
    }
    const text = readSpeakableRealtimeVoiceToolResult(params.result, {
      maxChars: FORCED_CONSULT_RESULT_MAX_CHARS,
    });
    const providerOptions = suppressedToolResultOptions(session);
    const providerResult = providerOptions ? buildAlreadyDeliveredToolResult() : params.result;
    const terminal: ForcedTerminalProviderResult = {
      result: providerResult,
      options: providerOptions,
      turnId,
      epoch: session.toolResultEpoch,
    };
    session.forcedTerminalProviderResults.set(forcedConsult.id, terminal);
    const submission = drainForcedTerminalProviderResults(session, forcedConsult, terminal);
    const clearTerminal = () => {
      if (session.forcedTerminalProviderResults.get(forcedConsult.id) === terminal) {
        session.forcedTerminalProviderResults.delete(forcedConsult.id);
      }
    };
    const completion = completeAfterToolResultSubmissions(session, [submission], () => {
      clearTerminal();
      if (session.toolResultEpoch !== terminal.epoch) {
        return;
      }
      session.harness.forcedConsults.markDelivered(forcedConsult);
      clearRelayAgentToolCall(session, params.callId);
      session.completedAgentToolCalls.add(params.callId);
      const hasNativeCalls = session.harness.forcedConsults.nativeCallIds(forcedConsult).length > 0;
      if (text && (!hasNativeCalls || providerOptions)) {
        session.bridge.sendUserMessage(buildForcedConsultSpeechPrompt(text));
      }
      broadcastToolResultToOwner(session, {
        callId: params.callId,
        turnId,
        result: params.result,
        forced: true,
        final: true,
      });
    });
    const trackedCompletion = completion?.finally(clearTerminal);
    return trackAgentFinalToolResult(session, params.callId, trackedCompletion);
  }
  if (cancelledAgentCall) {
    const providerResult = buildRealtimeVoiceAgentCancelProviderResult(
      "OpenClaw cancelled this consult before completion. Do not restart it.",
    );
    const submitCancellation = () =>
      submitFinalProviderToolResult({
        session,
        callId: params.callId,
        result: providerResult,
        options: suppressedToolResultOptions(session),
        onAccepted: () => {
          session.cancelledAgentToolCalls.delete(params.callId);
          session.completedAgentToolCalls.add(params.callId);
        },
      });
    const pendingProvider = session.pendingProviderToolResults.get(params.callId);
    const completion = pendingProvider
      ? pendingProvider.then(submitCancellation, submitCancellation)
      : submitCancellation();
    return trackAgentFinalToolResult(session, params.callId, completion);
  }
  if (
    params.options?.suppressResponse === true &&
    session.bridge.bridge.supportsToolResultSuppression === false
  ) {
    throw new Error("Realtime provider does not support suppressed tool results");
  }
  // A final result owns provider completion for this call. Follow-up RPCs share it so
  // only one accepted submission can clear the linked run and emit the success event.
  const final = params.options?.willContinue !== true;
  const turnId = ensureRelayTurn(session);
  const epoch = session.toolResultEpoch;
  const onAccepted = () => {
    if (session.toolResultEpoch !== epoch) {
      return;
    }
    if (final) {
      clearRelayAgentToolCall(session, params.callId);
      session.completedAgentToolCalls.add(params.callId);
    }
    broadcastToolResultToOwner(session, {
      callId: params.callId,
      turnId,
      result: params.result,
      final,
    });
  };
  if (final) {
    const completion = submitFinalProviderToolResult({
      session,
      callId: params.callId,
      result: params.result,
      options: params.options,
      onAccepted,
    });
    return trackAgentFinalToolResult(session, params.callId, completion);
  }
  const submit = () =>
    session.bridge.submitToolResult(params.callId, params.result, params.options);
  const pendingWorking = session.pendingWorkingToolResults.get(params.callId);
  if (pendingWorking) {
    const submission = pendingWorking.then(async () => {
      if (relaySessions.get(session.id) !== session || session.toolResultEpoch !== epoch) {
        return false;
      }
      await submit();
      return true;
    });
    const completion = submission.then((submitted) => {
      if (submitted && relaySessions.get(session.id) === session) {
        onAccepted();
      }
    });
    return trackPendingWorkingToolResult(session, params.callId, completion);
  }
  const submission = submit();
  const completion = completeAfterToolResultSubmissions(session, [submission], onAccepted);
  return trackPendingWorkingToolResult(session, params.callId, completion);
}

/** Tracks the chat run started for a realtime agent-consult tool call. */
export function registerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
  runId: string;
  callId?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.activeAgentRuns.set(params.runId, params.sessionKey);
  if (params.callId?.trim()) {
    session.activeAgentToolCalls.set(params.callId.trim(), params.runId);
  }
  if (!session.sessionKey) {
    session.sessionKey = params.sessionKey;
  }
  if (!ensureRelayVoiceSession(session)) {
    throw new Error("Realtime relay voice session could not be created for agent consult");
  }
  registerClientVoiceConsultRun({
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    sessionKey: params.sessionKey,
    voiceSessionId: session.id,
    runId: params.runId,
  });
}

/** Wait for server-owned final transcript appends before a relay consult is authorized. */
export async function flushTalkRealtimeRelayVoiceWrites(params: {
  relaySessionId: string;
  connId: string;
}): Promise<void> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  await session.voiceTranscriptWrites;
}

/** Applies realtime voice-control text to the active agent-consult chat run. */
export async function steerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey?: string;
  text: string;
  mode?: string;
}): Promise<RealtimeVoiceAgentControlResult> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const sessionKey = session.sessionKey;
  if (!sessionKey) {
    throw new Error("Realtime relay steering requires a session key");
  }
  const requestedSessionKey = params.sessionKey?.trim();
  if (requestedSessionKey && requestedSessionKey !== sessionKey) {
    throw new Error("Realtime relay steering session key does not match the relay session");
  }
  const result = await controlRealtimeVoiceAgentRun({
    sessionKey,
    text: params.text,
    mode: params.mode,
    recentEvents: session.harness.talk.recentEvents,
  });
  if (relaySessions.get(session.id) !== session) {
    throw new Error("Realtime relay session closed while steering the agent run");
  }
  const turnId = ensureRelayTurn(session);
  const providerSubmission = submitRelayAgentControlProviderResults(session, result, turnId);
  if (providerSubmission?.completion) {
    await providerSubmission.completion;
  }
  const finalResult = providerSubmission?.providerResponseStarted
    ? { ...result, suppress: true }
    : result;
  if (relaySessions.get(session.id) !== session) {
    return finalResult;
  }
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolProgress",
    result: finalResult,
    talkEvent: session.harness.talk.emit({
      type: "tool.progress",
      turnId,
      payload: {
        name: "openclaw_agent_control",
        phase: finalResult.mode,
        result: finalResult,
      },
      final: finalResult.mode === "cancel" || finalResult.mode === "status",
    }),
  });
  return finalResult;
}

/** Cancels the active relay turn, aborts agent work, and clears provider audio. */
export function cancelTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
  reason?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.toolResultEpoch += 1;
  session.forcedTerminalProviderResults.clear();
  const turnId = ensureRelayTurn(session);
  const reason = params.reason ?? "client-cancelled";
  cancelForcedConsults(session);
  for (const callId of session.activeAgentToolCalls.keys()) {
    session.cancelledAgentToolCalls.set(callId, turnId);
  }
  for (const forcedConsult of session.harness.forcedConsults.handles()) {
    if (session.harness.forcedConsults.isCancelled(forcedConsult)) {
      session.cancelledAgentToolCalls.set(forcedConsult.id, turnId);
      for (const nativeCallId of session.harness.forcedConsults.nativeCallIds(forcedConsult)) {
        session.cancelledAgentToolCalls.set(nativeCallId, turnId);
      }
    }
  }
  const outputGeneration = session.outputMedia?.generation;
  session.harness.handleBargeIn({ audioPlaybackActive: true }, noFallbackRelayOutputFlush);
  if (session.outputMedia && session.outputMedia.generation === outputGeneration) {
    session.outputMedia.clear(reason === "barge-in" ? "barge-in" : "cancel");
  }
  session.outputMedia?.setState("listening");
  abortRelayAgentRuns(session, reason);
  const cancelled = session.harness.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "clear",
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
}

/** Closes a realtime relay session owned by the current connection. */
export function stopTalkRealtimeRelaySession(params: {
  relaySessionId: string;
  connId: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  closeRelaySession(session, "completed");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
