import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage as formatError } from "../../../infra/errors.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../../../talk/agent-run-control-shared.js";
import {
  controlRealtimeVoiceAgentRun,
  type RealtimeVoiceAgentControlResult,
} from "../../../talk/agent-run-control.js";
import { withClientVoiceSessionSettlement } from "../../../talk/client-voice-session-lifecycle.js";
import type {
  RealtimeVoiceCloseOptions,
  RealtimeVoiceToolResultOptions,
} from "../../../talk/provider-types.js";
import { resolveRealtimeVoiceBargeIn } from "../../../talk/realtime-session-policy.js";
import { abortChatRunById } from "../../chat-abort.js";
import { decodeTalkRelayAudioBase64 } from "../relay-audio-base64.js";
import {
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
import { createRelayAgentRunRegistration } from "./agent-consult.js";
import { scheduleRelayCancellationDeadline } from "./cancellation-deadline.js";
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
  trackToolResultCompletion,
} from "./provider-results.js";
import {
  MAX_AUDIO_BASE64_BYTES,
  broadcastRelaySessionClosed,
  broadcastToOwner,
  cancelRelayTurn,
  drainingRelaySessions,
  ensureRelayTurn,
  relaySessions,
  resolveRelayProviderToolCallId,
  retireRelayAgentRuns,
  type RelaySession,
} from "./state.js";
import {
  captureRelayVoiceSessionSource,
  closeRelayVoiceSession,
  ensureRelayVoiceSession,
} from "./voice.js";

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
export async function ensureTalkRealtimeRelayVoiceSession(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
}): Promise<void> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.sessionTarget.sessionKey !== params.sessionKey.trim()) {
    throw new Error("Realtime relay session belongs to another agent session");
  }
  if (!(await ensureRelayVoiceSession(session))) {
    throw new Error("Realtime relay voice session could not be created");
  }
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
  const completion = createDeferredCore();
  const closing: NonNullable<RelaySession["closing"]> = {
    reason,
    completion: completion.promise,
  };
  session.closing = closing;
  const close = async (admissionFailure?: { error: unknown }) => {
    try {
      if (admissionFailure) {
        throw admissionFailure.error;
      }
      const source = captureRelayVoiceSessionSource(session);
      if (session.voiceSessionCreated) {
        source.assertCurrent();
      }
    } catch (error) {
      closing.reason = "error";
      closing.runTranscript = () => false;
      session.voiceTranscriptQueue.seal();
      const accepted = (session.voiceSessionClose ??= session.voiceTranscriptQueue.flush());
      try {
        await finishRelaySessionClose(session, "error", closing, () => accepted, options);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Realtime relay close failed", {
          cause: cleanupError,
        });
      }
      throw error;
    }
    closing.runTranscript = AsyncLocalStorage.bind((run: () => boolean) => run());
    await finishRelaySessionClose(
      session,
      reason,
      closing,
      () => closeRelayVoiceSession(session),
      options,
    );
  };
  void withClientVoiceSessionSettlement(
    close,
    (error) => close({ error }),
    session.voiceSessionSource?.settlementContext,
  ).then(completion.resolve, completion.reject);
  // Disconnects, expiry, and provider callbacks have no RPC caller to observe cleanup failures.
  void completion.promise.catch((error: unknown) => {
    session.context.logGateway.warn(
      `failed to close realtime relay session: ${formatError(error)}`,
    );
  });
  return completion.promise;
}

function finishRelaySessionClose(
  session: RelaySession,
  reason: "completed" | "error",
  closing: NonNullable<RelaySession["closing"]>,
  closeVoice: () => Promise<void>,
  options?: RealtimeVoiceCloseOptions & { eventReason?: "output-cancelled" },
): Promise<void> {
  session.runAuthority?.release();
  const disposition =
    options?.disposition ??
    (isTalkVoiceSessionReplacing(session.id, session.connId, session.sessionTarget.agentId)
      ? "detach"
      : "abort");
  unregisterTalkVoiceSession(session.id, session.connId, session.sessionTarget.agentId);
  session.transcriptReadiness.close();
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
    const voiceClose = closeVoice();
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
  let providerClose: void | Promise<void>;
  try {
    providerClose = session.bridge.close({ disposition });
  } catch (error) {
    return failClose(error);
  }
  return providerClose ? providerClose.then(finish, failClose) : finish();
}

function closeTalkRealtimeRelaySessionsForConnection(connId: string): Promise<void> {
  return closeTalkRelaySessionsForConnection({
    sessions: [...relaySessions.values(), ...drainingRelaySessions],
    connId,
    closeSession: (session) => closeRelaySession(session, "completed", { disposition: "detach" }),
    onCloseError: (error, session) => {
      session.context.logGateway.warn(
        `failed to close realtime relay session after connection disconnect: ${formatError(error)}`,
      );
    },
  });
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
  broadcastToOwner(
    session,
    { type: "inputAudio", byteLength: audio.byteLength },
    {
      type: "input.audio.delta",
      turnId,
      payload: { byteLength: audio.byteLength },
    },
  );
  if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) {
    session.bridge.setMediaTimestamp(params.timestamp);
  }
}

export function acknowledgeTalkRealtimeRelayMark(params: {
  relaySessionId: string;
  connId: string;
  markName: string;
}): void {
  getRelaySession(params.relaySessionId, params.connId).bridge.acknowledgeMark(params.markName);
}

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
      result: params.result,
      options: params.options,
    });
  }

  if (cancelledAgentCall) {
    const cancellationEpoch = session.toolResultEpoch;
    const providerResult = buildRealtimeVoiceAgentCancelProviderResult(
      "OpenClaw cancelled this consult before completion. Do not restart it.",
    );
    const submitCancellation = () => {
      if (
        relaySessions.get(session.id) !== session ||
        session.toolResultEpoch !== cancellationEpoch
      ) {
        return;
      }
      return submitFinalProviderToolResult({
        session,
        callId: params.callId,
        result: providerResult,
        options: suppressedToolResultOptions(session),
        onAccepted: () => {
          session.toolCalls.deleteCancelled(params.callId);
          session.toolCalls.markAgentCompleted([params.callId]);
        },
      });
    };
    const pendingProvider = session.pendingProviderToolResults.get(params.callId);
    const completion = pendingProvider
      ? pendingProvider.then(submitCancellation, submitCancellation)
      : submitCancellation();
    return trackToolResultCompletion(session.pendingFinalToolResults, params.callId, completion);
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
    return trackToolResultCompletion(session.pendingFinalToolResults, params.callId, completion);
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
    return trackToolResultCompletion(session.pendingWorkingToolResults, params.callId, completion);
  }
  const submission = submit();
  const completion = completeAfterToolResultSubmissions(session, [submission], onAccepted);
  return trackToolResultCompletion(session.pendingWorkingToolResults, params.callId, completion);
}

export const registerTalkRealtimeRelayAgentRun = createRelayAgentRunRegistration(getRelaySession);

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

  const registration = session.activeAgentToolCalls.get(relayCallId);
  if (registration?.isCurrent()) {
    const { run } = registration;
    abortChatRunById(session.context, {
      runId: run.runId,
      sessionKey: run.sessionKey,
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
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (relaySessions.get(session.id) !== session) {
      throw new Error("Realtime relay session closed while steering the agent run");
    }
  };
  const runTarget = resolveOwnedActiveTalkRunTarget({
    context: session.context,
    clientConnId: session.connId,
    sessionTarget: session.sessionTarget,
    scope: { kind: "voice-session", voiceSessionId: session.id },
    assertCurrent,
  });
  return async () => {
    assertCurrent();
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
    broadcastToOwner(
      session,
      { type: "toolProgress", result: finalResult },
      {
        type: "tool.progress",
        turnId,
        payload: {
          name: "openclaw_agent_control",
          phase: finalResult.mode,
          result: finalResult,
        },
        final: finalResult.mode === "cancel" || finalResult.mode === "status",
      },
    );
    return finalResult;
  };
}

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
  if (session.outputOwnership.phase !== "unowned" && session.outputOwnership.turnId !== turnId) {
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
  const forcedNativeCallIds = new Set(forcedConsults.flatMap(({ nativeCallIds }) => nativeCallIds));
  const rootCallIds = new Set([
    ...session.activeAgentToolCalls.keys(),
    ...forcedConsults.map(({ handle }) => handle.id),
  ]);
  for (const [callId, providerCallId] of session.providerToolCallIds) {
    if (
      !forcedNativeCallIds.has(providerCallId) &&
      !session.toolCalls.isAgentCompleted(callId) &&
      !session.toolCalls.isProviderCompleted(providerCallId)
    ) {
      rootCallIds.add(callId);
    }
  }
  const terminalEpoch = ++session.toolResultEpoch;
  session.forcedTerminalProviderResults.clear();
  if (!session.toolCalls.markCancelled([...rootCallIds, ...forcedNativeCallIds], turnId)) {
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
  scheduleRelayCancellationDeadline(session, { turnId, reason, terminalEpoch });
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

export function stopTalkRealtimeRelaySession(params: {
  relaySessionId: string;
  connId: string;
}): void | Promise<void> {
  return closeRelaySession(getRelaySession(params.relaySessionId, params.connId), "completed");
}
