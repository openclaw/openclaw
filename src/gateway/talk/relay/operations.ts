import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createDeferredCore } from "../../../shared/deferred.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../../../talk/agent-run-control-shared.js";
import {
  controlRealtimeVoiceAgentRun,
  type RealtimeVoiceAgentControlResult,
} from "../../../talk/agent-run-control.js";
import { registerClientVoiceConsultRun } from "../../../talk/client-voice-session.js";
import type {
  RealtimeVoiceCloseOptions,
  RealtimeVoiceToolResultOptions,
} from "../../../talk/provider-types.js";
import { resolveRealtimeVoiceBargeIn } from "../../../talk/realtime-session-policy.js";
import type { TalkEvent } from "../../../talk/talk-session-controller.js";
import { abortChatRunById } from "../../chat-abort.js";
import { formatError } from "../../server-utils.js";
import { decodeTalkRelayAudioBase64 } from "../relay-audio-base64.js";
import {
  closeExpiredTalkRelaySessions,
  closeTalkRelaySessionsForConnection,
  requireActiveTalkRelaySession,
} from "../relay-session-lifecycle.js";
import { resolveOwnedActiveTalkRunTarget } from "../run-ownership.js";
import { forgetUnifiedTalkSession, registerTalkConnectionCleanup } from "../session-registry.js";
import {
  cancelTalkVoiceSessionChange,
  isTalkVoiceSessionReplacing,
  registerTalkVoiceSession,
  unregisterTalkVoiceSession,
} from "../voice-selection.js";
import {
  submitForcedTalkRealtimeRelayToolResult,
  submitRelayAgentControlProviderResults,
} from "./forced-consults.js";
import {
  broadcastToolResultToOwner,
  clearRelayAgentToolCall,
  completeAfterToolResultSubmissions,
  submitFinalProviderToolResult,
  suppressedToolResultOptions,
  trackAgentFinalToolResult,
  trackPendingWorkingToolResult,
} from "./provider-results.js";
import {
  MAX_AUDIO_BASE64_BYTES,
  MAX_RELAY_SESSIONS_GLOBAL,
  MAX_RELAY_SESSIONS_PER_CONN,
  broadcastRelaySessionClosed,
  broadcastToOwner,
  cancelRelayTurn,
  drainingRelaySessions,
  ensureRelayTurn,
  noFallbackRelayOutputFlush,
  relaySessions,
  resolveRelayProviderToolCallId,
  type RelaySession,
} from "./state.js";
import { closeRelayVoiceSession, ensureRelayVoiceSession } from "./voice.js";

const TURN_BOUND_CANCELLATION_DRAIN_MS = 1_000;

export function adoptTalkRealtimeRelaySession(
  session: RelaySession,
  voice: Omit<
    Parameters<typeof registerTalkVoiceSession>[0],
    "voiceSessionId" | "connId" | "sessionTarget"
  >,
): void {
  session.cleanupTimer.unref?.();
  relaySessions.set(session.id, session);
  registerTalkConnectionCleanup(session.connId, "realtime-relay", () =>
    closeTalkRealtimeRelaySessionsForConnection(session.connId),
  );
  try {
    registerTalkVoiceSession({
      ...voice,
      voiceSessionId: session.id,
      connId: session.connId,
      sessionTarget: session.sessionTarget,
    });
  } catch (error) {
    void closeRelaySession(session, "error");
    throw error;
  }
}

/** Ensure a gateway-relay call has its durable record before transcript-free RPCs. */
export function ensureTalkRealtimeRelayVoiceSession(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.sessionTarget.sessionKey !== params.sessionKey.trim()) {
    throw new Error("Realtime relay session belongs to another agent session");
  }
  if (!ensureRelayVoiceSession(session)) {
    throw new Error("Realtime relay voice session could not be created");
  }
}

/** Omitting the abort reason releases relay correlation while accepted work continues. */
function retireRelayAgentRuns(session: RelaySession, reason?: string): void {
  if (reason !== undefined) {
    for (const [runId, sessionKey] of session.activeAgentRuns) {
      abortChatRunById(session.context, {
        runId,
        sessionKey,
        stopReason: reason,
      });
    }
  }
  session.activeAgentRuns.clear();
  session.activeAgentToolCalls.clear();
}

export function pruneInactiveRelayAgentRuns(session: RelaySession): number {
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

export function closeRelaySession(
  session: RelaySession,
  reason: "completed" | "error",
  options?: RealtimeVoiceCloseOptions & { eventReason?: "output-cancelled" },
): void | Promise<void> {
  if (session.closing) {
    if (reason === "error") {
      session.closing.reason = reason;
    }
    return session.closing.completion;
  }
  const closing: NonNullable<RelaySession["closing"]> = { reason };
  session.closing = closing;
  const disposition =
    options?.disposition ??
    (isTalkVoiceSessionReplacing(session.id, session.connId, session.sessionTarget.agentId)
      ? "detach"
      : "abort");
  unregisterTalkVoiceSession(session.id, session.connId, session.sessionTarget.agentId);
  session.confirmationReadiness.close();
  session.harness.close();
  session.outputOwnership.drain?.resolve();
  relaySessions.delete(session.id);
  drainingRelaySessions.add(session);
  forgetUnifiedTalkSession(session.id);
  clearTimeout(session.cleanupTimer);
  retireRelayAgentRuns(
    session,
    disposition === "detach" ? undefined : reason === "error" ? "relay-error" : "relay-closed",
  );
  const finish = () => {
    const voiceClose = closeRelayVoiceSession(session);
    void voiceClose.then(
      () => drainingRelaySessions.delete(session),
      () => drainingRelaySessions.delete(session),
    );
    broadcastRelaySessionClosed(session, closing.reason, options?.eventReason);
    return voiceClose;
  };
  const failClose = async (error: unknown): Promise<never> => {
    closing.reason = "error";
    await finish();
    throw error;
  };
  let providerClose: void | Promise<void> = undefined;
  try {
    providerClose = session.bridge.close({ disposition });
  } catch (error) {
    closing.completion = failClose(error);
  }
  closing.completion ??= providerClose ? providerClose.then(finish, failClose) : finish();
  // Disconnects, expiry, and provider callbacks have no RPC caller to observe cleanup failures.
  void closing.completion.catch((error: unknown) => {
    session.context.logGateway.warn(
      `failed to close realtime relay session: ${formatError(error)}`,
    );
  });
  return closing.completion;
}

/** Releases every realtime relay session owned by a disconnected gateway connection. */
function closeTalkRealtimeRelaySessionsForConnection(connId: string): void {
  closeTalkRelaySessionsForConnection({
    sessions: relaySessions.values(),
    connId,
    closeSession: (session) =>
      void closeRelaySession(session, "completed", { disposition: "detach" }),
    onCloseError: (error, session) => {
      session.context.logGateway.warn(
        `failed to close realtime relay session after connection disconnect: ${formatError(error)}`,
      );
    },
  });
}

export function enforceRelaySessionLimits(connId: string): void {
  closeExpiredTalkRelaySessions({
    sessions: relaySessions.values(),
    closeSession: (session) => void closeRelaySession(session, "completed"),
  });
  const sessions = [...relaySessions.values(), ...drainingRelaySessions];
  if (sessions.length >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error("Too many active realtime relay sessions");
  }
  const connectionCount = sessions.filter((session) => session.connId === connId).length;
  if (connectionCount >= MAX_RELAY_SESSIONS_PER_CONN) {
    throw new Error("Too many active realtime relay sessions for this connection");
  }
}

function getRelaySession(relaySessionId: string, connId: string): RelaySession {
  return requireActiveTalkRelaySession({
    sessions: relaySessions,
    sessionId: relaySessionId,
    connId,
    closeSession: (session) => void closeRelaySession(session, "completed"),
    unknownSessionMessage: "Unknown realtime relay session",
  });
}

/** Streams one base64-encoded browser audio frame into the owning relay. */
export function sendTalkRealtimeRelayAudio(params: {
  relaySessionId: string;
  connId: string;
  audioBase64: string;
  timestamp?: number;
}): void | Promise<void> {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Realtime relay audio frame is too large");
  }
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.outputOwnership.phase === "cancelling") {
    return session.outputOwnership.drain!.promise.then(() => sendTalkRealtimeRelayAudio(params));
  }
  const audio = decodeTalkRelayAudioBase64(params.audioBase64, "Realtime relay");
  const turnId = ensureRelayTurn(session);
  session.bridge.sendAudio(audio);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "inputAudio",
    byteLength: audio.byteLength,
    talkEvent: session.harness.talk.emit({
      type: "input.audio.delta",
      turnId,
      payload: { byteLength: audio.byteLength },
    }),
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
  getRelaySession(params.relaySessionId, params.connId).bridge.acknowledgeMark(params.markName);
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
  if (session.toolCalls.isAgentCompleted(params.callId)) {
    return;
  }
  if (
    session.outputOwnership.phase === "cancelling" &&
    !session.toolCalls.hasCancelled(params.callId)
  ) {
    return;
  }
  if (!session.toolCalls.tryAdmit([params.callId])) {
    return;
  }
  const pendingFinal = session.pendingFinalToolResults.get(params.callId);
  const cancelledAgentCall = session.toolCalls.hasCancelled(params.callId);
  if (pendingFinal && !cancelledAgentCall) {
    return pendingFinal;
  }
  const forcedConsult = session.harness.forcedConsults
    .handles()
    .find((handle) => handle.id === params.callId);

  if (forcedConsult) {
    return submitForcedTalkRealtimeRelayToolResult(session, forcedConsult, {
      callId: params.callId,
      result: params.result,
      options: params.options,
    });
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
          session.toolCalls.deleteCancelled(params.callId);
          session.toolCalls.markAgentCompleted([params.callId]);
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
      if (!session.toolCalls.markAgentCompleted([params.callId])) {
        return;
      }
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
    session.bridge.submitToolResult(
      resolveRelayProviderToolCallId(session, params.callId),
      params.result,
      params.options,
    );
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
  const callId = params.callId?.trim();
  if (callId && session.toolCalls.isAgentCompleted(callId)) {
    // Provider cancellation can win while chat.send is still acknowledging. Abort
    // the late run before it can escape the relay's call-ownership tombstone.
    abortChatRunById(session.context, {
      runId: params.runId,
      sessionKey: params.sessionKey,
      stopReason: "realtime provider cancelled tool call",
    });
    throw new Error("Realtime provider cancelled the tool call before run registration");
  }
  if (callId && !session.toolCalls.tryAdmit([callId])) {
    throw new Error("Realtime relay tool-call session limit exceeded");
  }
  session.activeAgentRuns.set(params.runId, params.sessionKey);
  if (callId) {
    session.activeAgentToolCalls.set(callId, params.runId);
  }
  if (!ensureRelayVoiceSession(session)) {
    throw new Error("Realtime relay voice session could not be created for agent consult");
  }
  const { agentId, sessionKey } = session.sessionTarget;
  registerClientVoiceConsultRun({
    agentId,
    sessionKey,
    voiceSessionId: session.id,
    runId: params.runId,
  });
}

/** Retires one provider-owned tool call and aborts its exact relay consult, if started. */
export function cancelTalkRealtimeRelayProviderToolCall(
  session: RelaySession,
  providerCallId: string,
): string | undefined {
  const mappedRelayCallId = session.relayToolCallIdsByProviderId.get(providerCallId);
  if (!mappedRelayCallId) {
    return undefined;
  }
  const forcedConsult = session.harness.forcedConsults
    .handles()
    .find((handle) =>
      session.harness.forcedConsults.nativeCallIds(handle).includes(providerCallId),
    );
  // A native call can alias an already-started forced consult. Cancellation owns
  // the forced handle because that is where the browser run was registered.
  const relayCallId = forcedConsult?.id ?? mappedRelayCallId;
  if (
    session.toolCalls.isAgentCompleted(relayCallId) ||
    session.toolCalls.isAgentCompleted(mappedRelayCallId) ||
    session.toolCalls.isProviderCompleted(providerCallId)
  ) {
    return undefined;
  }
  if (forcedConsult) {
    session.harness.forcedConsults.markCancelled(forcedConsult);
    if (!session.toolCalls.markCancelled([relayCallId], ensureRelayTurn(session))) {
      return undefined;
    }
  } else {
    session.toolCalls.deleteCancelled(relayCallId);
  }
  if (
    !session.toolCalls.markAgentCompleted([relayCallId, mappedRelayCallId]) ||
    !session.toolCalls.markProviderCompleted([providerCallId])
  ) {
    return undefined;
  }

  const runId = session.activeAgentToolCalls.get(relayCallId);
  const sessionKey = runId ? session.activeAgentRuns.get(runId) : undefined;
  if (runId && sessionKey) {
    abortChatRunById(session.context, {
      runId,
      sessionKey,
      stopReason: "realtime provider cancelled tool call",
    });
  }
  clearRelayAgentToolCall(session, relayCallId);
  session.providerToolCallIds.delete(mappedRelayCallId);
  session.relayToolCallIdsByProviderId.delete(providerCallId);
  return relayCallId;
}

/** Wait for server-owned final transcript appends before a relay consult is authorized. */
export async function flushTalkRealtimeRelayVoiceWrites(params: {
  relaySessionId: string;
  connId: string;
}): Promise<void> {
  await getRelaySession(params.relaySessionId, params.connId).voiceTranscriptQueue.flush();
}

/** Applies realtime voice-control text to the active agent-consult chat run. */
export async function steerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey?: string;
  authority?: import("../client-gateway-control.js").TalkAgentConsultAuthority;
  text: string;
  mode?: string;
  assertCurrent?: () => void;
}): Promise<RealtimeVoiceAgentControlResult> {
  return await prepareTalkRealtimeRelayAgentControl(params)();
}

/** Capture the call-owned registration before control queue/readiness waits. */
export function prepareTalkRealtimeRelayAgentControl(
  params: Parameters<typeof steerTalkRealtimeRelayAgentRun>[0],
): () => Promise<RealtimeVoiceAgentControlResult> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const { sessionKey, canonicalKey } = session.sessionTarget;
  const requestedSessionKey = params.sessionKey?.trim();
  if (requestedSessionKey && requestedSessionKey !== sessionKey) {
    throw new Error("Realtime relay steering session key does not match the relay session");
  }
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context: session.context,
    clientConnId: session.connId,
    sessionTarget: session.sessionTarget,
    scope: { kind: "voice-session", voiceSessionId: session.id },
    assertCurrent: () => {
      params.assertCurrent?.();
      if (relaySessions.get(session.id) !== session) {
        throw new Error("Realtime relay session closed while steering the agent run");
      }
    },
  });
  return async () => {
    params.assertCurrent?.();
    if (relaySessions.get(session.id) !== session) {
      throw new Error("Realtime relay session closed while steering the agent run");
    }
    const result = await controlRealtimeVoiceAgentRun({
      sessionKey: canonicalKey,
      runTarget,
      getToolAuthorityOverlay: () => {
        if (!session.getToolAuthorityOverlay) {
          throw new Error("Relay steering caller authority is unavailable");
        }
        return session.getToolAuthorityOverlay(params.authority, runTarget?.toolAuthoritySource);
      },
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
  };
}

/** Cancels the active relay turn, aborts agent work, and clears provider audio. */
export async function cancelTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
  reason?: string;
  turnId?: string;
}) {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const turnId = session.harness.talk.activeTurnId;
  if (!turnId) {
    return { status: "idle" as const };
  }
  const requestedTurnId = normalizeOptionalString(params.turnId);
  if (requestedTurnId && turnId !== requestedTurnId) {
    return { status: "stale" as const };
  }
  if (session.outputOwnership.phase === "owned" && session.outputOwnership.turnId !== turnId) {
    return { status: "stale" as const };
  }
  const reason = params.reason ?? "client-cancelled";
  if (reason !== "barge-in") {
    cancelTalkVoiceSessionChange(session.id, session.connId, session.sessionTarget.agentId);
  }
  if (
    !resolveRealtimeVoiceBargeIn({
      configuredBargeIn: true,
      interruptResponseOnInputAudio: true,
      capabilities: session.capabilities,
      outputAudioMode: session.bridge.bridge.outputAudioMode,
    })
  ) {
    if (reason === "barge-in") {
      return { status: "idle" as const };
    }
    // Continuous providers cannot confirm a cancelled response. Explicit stops end
    // the session through its graceful owner instead of waiting for that event.
    cancelRelayTurn(session, turnId, reason);
    await closeRelaySession(session, "completed", {
      disposition: "abort",
      eventReason: "output-cancelled",
    });
    return { status: "applied" as const, turnId };
  }
  const forcedConsults = session.harness.forcedConsults.handles().map((handle) => ({
    handle,
    nativeCallIds: session.harness.forcedConsults.nativeCallIds(handle),
  }));
  const rootCallIds = new Set([
    ...session.activeAgentToolCalls.keys(),
    ...forcedConsults.map(({ handle }) => handle.id),
  ]);
  const terminalEpoch = ++session.toolResultEpoch;
  session.forcedTerminalProviderResults.clear();
  if (
    !session.toolCalls.markCancelled(
      [...rootCallIds, ...forcedConsults.flatMap(({ nativeCallIds }) => nativeCallIds)],
      turnId,
    )
  ) {
    throw new Error("Realtime relay cancellation could not record tool state");
  }
  for (const { handle, nativeCallIds } of forcedConsults) {
    session.harness.forcedConsults.markCancelled(handle);
    session.forcedTerminalProviderResults.set(handle.id, {
      result: buildRealtimeVoiceAgentCancelProviderResult(
        "OpenClaw cancelled this consult before completion. Do not restart it.",
      ),
      options: suppressedToolResultOptions(session),
      turnId,
      epoch: terminalEpoch,
      nativeCallIds,
    });
  }
  session.outputOwnership.phase = "cancelling";
  session.outputOwnership.turnId = turnId;
  const cancellationDrained = (session.outputOwnership.drain = createDeferredCore());
  retireRelayAgentRuns(session, reason);
  cancelRelayTurn(session, turnId, reason);
  setTimeout(() => {
    if (
      relaySessions.get(session.id) === session &&
      session.toolResultEpoch === terminalEpoch &&
      session.outputOwnership.phase === "cancelling"
    ) {
      void closeRelaySession(session, "completed");
    }
  }, TURN_BOUND_CANCELLATION_DRAIN_MS).unref?.();
  void Promise.allSettled(
    [...rootCallIds].map(async (callId) => {
      await submitTalkRealtimeRelayToolResult({
        relaySessionId: session.id,
        connId: session.connId,
        callId,
        result: { status: "cancelled" },
      });
    }),
  );
  try {
    session.bridge.handleBargeIn({ audioPlaybackActive: true });
  } catch {
    session.failSession("Realtime provider cancellation failed. Reconnecting.");
  }
  return cancellationDrained.promise.then(() => ({ status: "applied" as const, turnId }));
}

/** Drops one provider generation without sending cancellation into its replacement. */
export function resetTalkRealtimeRelayContinuity(
  session: RelaySession,
  reason = "session.continuity.reset",
): TalkEvent | undefined {
  session.toolResultEpoch += 1;
  const retiredCallIds = new Set<string>([
    ...session.activeAgentToolCalls.keys(),
    ...session.toolCalls.cancelledCallIds(),
    ...session.providerToolCallIds.keys(),
    ...session.providerToolCallIds.values(),
    ...session.pendingFinalToolResults.keys(),
    ...session.pendingProviderToolResults.keys(),
    ...session.pendingWorkingToolResults.keys(),
    ...session.forcedTerminalProviderResults.keys(),
  ]);
  for (const handle of session.harness.forcedConsults.handles()) {
    retiredCallIds.add(handle.id);
    for (const nativeCallId of session.harness.forcedConsults.nativeCallIds(handle)) {
      retiredCallIds.add(nativeCallId);
    }
  }
  if (!session.toolCalls.markAgentCompleted(retiredCallIds)) {
    return undefined;
  }
  session.toolCalls.clearCancelled();
  session.providerToolCallIds.clear();
  session.relayToolCallIdsByProviderId.clear();
  session.pendingFinalToolResults.clear();
  session.toolCalls.clearProviderCompleted();
  session.pendingProviderToolResults.clear();
  session.pendingWorkingToolResults.clear();
  session.forcedTerminalProviderResults.clear();
  session.harness.forcedConsults.clear();
  retireRelayAgentRuns(session, reason);
  const turnId = session.harness.talk.activeTurnId;
  session.harness.flushOutput(noFallbackRelayOutputFlush);
  session.harness.finishOutputAudio(reason);
  if (!turnId) {
    return undefined;
  }
  const cancelled = session.harness.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  return cancelled.ok ? cancelled.event : undefined;
}

/** Closes a realtime relay session owned by the current connection. */
export function stopTalkRealtimeRelaySession(params: {
  relaySessionId: string;
  connId: string;
}): void | Promise<void> {
  return closeRelaySession(getRelaySession(params.relaySessionId, params.connId), "completed");
}
