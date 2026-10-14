// Shared meeting bot realtime engines own provider and audio-transport orchestration.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceAgentConsultToolPolicy } from "../talk/agent-consult-tool.js";
import { isRealtimeVoiceAudioAudible } from "../talk/audio-energy.js";
import type { RealtimeVoiceTool, RealtimeVoiceToolCallEvent } from "../talk/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import { resolveRealtimeVoiceBargeIn } from "../talk/realtime-session-policy.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEventInput } from "../talk/talk-events.js";
import {
  resolveMeetingRealtimeAudioFormat,
  type MeetingRealtimeAudioFormat,
} from "./realtime-audio-format.js";
import type {
  MeetingRealtimeAudioTransport,
  MeetingRealtimeAudioTransportHealth,
} from "./realtime-audio-transport.js";
import {
  buildMeetingSpeakExactUserMessage,
  createMeetingRealtimeHarness,
  formatMeetingTranscriptSummaryLog,
  formatMeetingRealtimeVoiceModelLog,
  meetingOutputBytesPerMs,
  resolveMeetingRealtimeProvider,
} from "./realtime-engine-support.js";
import {
  createMeetingRealtimeOutputOwner,
  createMeetingRealtimeOutputQueue,
} from "./realtime-output-owner.js";
import { createMeetingRealtimeToolContinuity } from "./realtime-tool-continuity.js";

export type MeetingRuntimePlatform = {
  /** Adapter-owned identity keeps platform names and log prefixes out of core. */
  displayName: string;
  logScope: string;
  sessionIdPrefix: string;
};

export type MeetingRealtimeEngineConfig = {
  chrome: { audioFormat: MeetingRealtimeAudioFormat };
  realtime: {
    strategy: string;
    agentId?: string;
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    toolPolicy?: RealtimeVoiceAgentConsultToolPolicy;
    providers: Record<string, Record<string, unknown>>;
  };
};

export type MeetingAgentConsultParams = {
  meetingSessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  /** Meeting-owned cancellation for the active consult. */
  abortSignal?: AbortSignal;
};

export type MeetingRealtimeToolCallParams = {
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  meetingSessionId: string;
  requesterSessionKey?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  onTalkEvent: (event: TalkEventInput) => void;
};

export type MeetingRealtimeAudioEngineHealth = ReturnType<
  RealtimeVoiceSessionHarness["getHealth"]
> &
  MeetingRealtimeAudioTransportHealth & {
    lastClearAt?: string;
    clearCount?: number;
    bridgeClosed: boolean;
  };

export type MeetingRealtimeAudioEngineHandle = {
  providerId: string;
  speak: (instructions?: string) => void;
  getHealth: () => MeetingRealtimeAudioEngineHealth;
  stop: () => Promise<void>;
};

export async function startMeetingRealtimeEngine(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  platform: MeetingRuntimePlatform;
  meetingSessionId: string;
  requesterSessionKey?: string;
  logPrefix?: "node";
  talkSessionId?: string;
  talkContext?: { nodeId: string; bridgeId: string };
  transport: MeetingRealtimeAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
  consultAgent: (params: MeetingAgentConsultParams) => Promise<{ text: string }>;
  tools: RealtimeVoiceTool[];
  handleToolCall: (params: MeetingRealtimeToolCallParams) => Promise<void>;
}): Promise<MeetingRealtimeAudioEngineHandle> {
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let bridgeClosed = false;
  let transportStopped = false;
  let transportDisposed = false;
  // Fatal transport callbacks can stop the session before its bridge exists.
  let bridge: RealtimeVoiceBridgeSession | undefined;
  let realtimeReady = false;
  let outputGenerationActive = false;
  let continuityResetActive = false;
  const outputOwner = createMeetingRealtimeOutputOwner();
  const toolContinuity = createMeetingRealtimeToolContinuity(params.handleToolCall);
  const realtimeLogScope = params.logPrefix ? `${params.logPrefix} realtime` : "realtime";
  const audioFormat = resolveMeetingRealtimeAudioFormat(params.config.chrome.audioFormat);
  const outputQueue = createMeetingRealtimeOutputQueue({
    transport: params.transport,
    bytesPerMs: meetingOutputBytesPerMs(params.config.chrome.audioFormat),
    onFailure: (source, error) => {
      params.logger.warn(
        `${params.platform.logScope} ${realtimeLogScope} ${source} failed: ${formatErrorMessage(error)}`,
      );
      stopAfterFailure(source);
    },
  });

  const stop = async () => {
    if (!stopped) {
      stopped = true;
      outputOwner.reset();
      outputQueue.stop();
      outputGenerationActive = false;
      toolContinuity.reset("meeting realtime stopped");
      harness.talkback?.close();
      harness.forcedConsults.clear();
    }
    if (stopPromise) {
      await stopPromise;
      return;
    }
    const cleanup = Promise.resolve().then(async () => {
      if (!bridgeClosed) {
        try {
          await bridge?.close();
        } catch (error) {
          params.logger.debug?.(
            `${params.platform.logScope} ${realtimeLogScope}${params.logPrefix ? "" : " voice"} bridge close ignored: ${formatErrorMessage(error)}`,
          );
        } finally {
          bridgeClosed = true;
          harness.close();
        }
      }
      let cleanupError: unknown;
      if (!transportStopped) {
        try {
          await params.transport.stop();
          transportStopped = true;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (!transportDisposed) {
        try {
          await params.transport.dispose();
          transportDisposed = true;
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError) {
        throw cleanupError instanceof Error
          ? cleanupError
          : new Error("Meeting realtime transport cleanup failed", { cause: cleanupError });
      }
    });
    stopPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (stopPromise === cleanup) {
        stopPromise = undefined;
      }
    }
  };
  const stopAfterFailure = (source: string) => {
    void stop().catch((error: unknown) => {
      params.logger.warn(
        `${params.platform.logScope} ${realtimeLogScope} ${source} cleanup failed: ${formatErrorMessage(error)}`,
      );
    });
  };
  const invalidateOutputPlayback = (): void => {
    outputQueue.invalidate();
    outputGenerationActive = false;
  };
  const invalidateAndClearOutputPlayback = (): void => {
    blockOutput();
    outputQueue.clear();
  };

  const blockOutput = (): { blocked: boolean; token: symbol } => {
    const result = outputOwner.block();
    invalidateOutputPlayback();
    return result;
  };

  const handleOutputBackpressure = () => {
    const { pendingBytes, pendingFrames } = outputQueue.pending();
    const block = bridge?.bridge.outputAudioMode === "continuous" ? undefined : blockOutput();
    if (block && !block.blocked) {
      return;
    }
    params.logger.warn(
      `${params.platform.logScope} ${realtimeLogScope} audio output backpressured: pendingBytes=${pendingBytes} pendingFrames=${pendingFrames}`,
    );
    if (!block) {
      invalidateOutputPlayback();
    }
    harness.flushOutput(outputQueue.clear);
    harness.finishOutputAudio("output-backpressure");
    if (!block) {
      return;
    }
    queueMicrotask(() => {
      if (stopped || !outputOwner.isBlockedBy(block.token)) {
        return;
      }
      harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () => {});
    });
  };

  const startHumanBargeInMonitor = () => {
    if (
      !params.transport.startBargeInMonitor ||
      !resolveRealtimeVoiceBargeIn({
        configuredBargeIn: undefined,
        interruptResponseOnInputAudio: undefined,
        capabilities: resolved.capabilities,
        outputAudioMode: bridge?.bridge.outputAudioMode,
      })
    ) {
      return;
    }
    params.transport.startBargeInMonitor(() => {
      if (stopped || !harness.outputActivity.isInterruptible()) {
        return false;
      }
      const now = Date.now();
      const playbackActive = harness.isOutputPlaybackWindowActive();
      const lastOutputAudioAt = harness.outputActivity.snapshot().lastAudioAt;
      if (!playbackActive && (lastOutputAudioAt === undefined || now - lastOutputAudioAt > 1_000)) {
        return false;
      }
      harness.handleBargeIn({ audioPlaybackActive: true }, invalidateAndClearOutputPlayback);
      return true;
    });
  };

  const resolved = await resolveMeetingRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const strategy = params.config.realtime.strategy;
  params.logger.info(
    formatMeetingRealtimeVoiceModelLog({
      logScope: params.platform.logScope,
      strategy,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      fallbackModel: params.config.realtime.model,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );
  const meetingTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId, meetingSessionId: params.meetingSessionId }
    : { meetingSessionId: params.meetingSessionId };
  const outputTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId }
    : { meetingSessionId: params.meetingSessionId };
  const reasonTalkPayload = (reason: string) =>
    params.talkContext ? { bridgeId: params.talkContext.bridgeId, reason } : { reason };
  const harness = createMeetingRealtimeHarness(params, {
    talk: {
      sessionId:
        params.talkSessionId ??
        `${params.platform.sessionIdPrefix}:${params.meetingSessionId}:command-realtime`,
      mode: "realtime",
      transport: "gateway-relay",
      brain:
        strategy === "bidi" && !resolved.capabilities?.handlesAgentConsult
          ? "direct-tools"
          : "agent-consult",
      provider: resolved.provider.id,
    },
    talkPayloads: {
      turnStarted: () => meetingTalkPayload,
      turnEnded: reasonTalkPayload,
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => outputTalkPayload,
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: reasonTalkPayload,
    },
    logPrefix: `${params.platform.logScope} ${realtimeLogScope} agent`,
    deliver: (text) => {
      bridge?.sendUserMessage(buildMeetingSpeakExactUserMessage(text));
    },
  });
  harness.emit({
    type: "session.started",
    payload: params.talkContext
      ? { ...meetingTalkPayload, nodeId: params.talkContext.nodeId }
      : meetingTalkPayload,
  });
  params.transport.onFatal(() => {
    stopAfterFailure("audio transport");
  });
  // onFatal replays a pre-registration failure synchronously; abort before creating a
  // voice bridge that the already-completed stop() could never close.
  if (stopped) {
    throw new Error(
      `${params.platform.displayName} audio transport failed before realtime provider setup`,
    );
  }
  try {
    const requireIsolatedInput = () => {
      if (!params.transport.inputAudioIsolated) {
        throw new Error(
          `${params.platform.displayName} native live voice requires isolated meeting audio input. Remove chrome.audioInputCommand to use managed browser capture, which must be available before connecting.`,
        );
      }
    };
    if (
      resolved.capabilities?.handlesInputAudioBargeIn === true &&
      resolved.capabilities.supportsBargeIn === false
    ) {
      requireIsolatedInput();
    }
    bridge = harness.createBridge({
      provider: resolved.provider,
      capabilities: resolved.capabilities,
      cfg: params.fullConfig,
      agentId: params.config.realtime.agentId,
      providerConfig: resolved.providerConfig,
      audioFormat,
      instructions: params.config.realtime.instructions,
      initialGreetingInstructions: params.config.realtime.introMessage,
      autoRespondToAudio: strategy === "bidi",
      triggerGreetingOnReady: false,
      markStrategy: "ack-immediately",
      tools: strategy === "bidi" && !resolved.capabilities?.handlesAgentConsult ? params.tools : [],
      ...(resolved.capabilities?.handlesAgentConsult
        ? {
            runAgentConsult: (request) => {
              if (stopped) {
                throw new Error("Meeting realtime session is closed");
              }
              return toolContinuity.runConsult(request, ({ prompt, signal }) => {
                if (params.config.realtime.toolPolicy === "none") {
                  throw new Error("Agent delegation is disabled by the meeting tool policy");
                }
                return params.consultAgent({
                  meetingSessionId: params.meetingSessionId,
                  requesterSessionKey: params.requesterSessionKey,
                  args: { question: prompt },
                  transcript: harness.transcript,
                  abortSignal: signal,
                });
              });
            },
          }
        : {}),
      audioSink: {
        isOpen: () => !stopped,
        sendAudio: (audio) => {
          const responseId = outputOwner.takeNextResponseId();
          const continuous = bridge?.bridge.outputAudioMode === "continuous";
          const audible = !continuous || isRealtimeVoiceAudioAudible(audio, audioFormat);
          if (!audible && !outputQueue.hasUnplayedAudibleAudio()) {
            if (outputGenerationActive) {
              outputGenerationActive = false;
              harness.finishOutputAudio("silence");
            }
            return;
          }
          if (stopped || (!continuous && !outputOwner.accept(responseId))) {
            return;
          }
          if (!outputQueue.enqueue(audio, audible, !outputGenerationActive)) {
            handleOutputBackpressure();
            return;
          }
          outputGenerationActive = true;
          harness.outputActivity.markPlaybackStarted();
          harness.recordOutputAudio(audio);
        },
        clearAudio: () => {
          const continuous = bridge?.bridge.outputAudioMode === "continuous";
          if (!continuous && !outputOwner.providerClear()) {
            return;
          }
          if (continuous) {
            outputOwner.reset();
          }
          invalidateOutputPlayback();
          harness.flushOutput(outputQueue.clear);
          harness.finishOutputAudio("clear");
        },
      },
      onTranscript: (role, text, isFinal) => {
        const turnId = harness.ensureTurn();
        const eventType =
          role === "assistant"
            ? isFinal
              ? "output.text.done"
              : "output.text.delta"
            : isFinal
              ? "transcript.done"
              : "transcript.delta";
        const payload = role === "assistant" ? { text } : { role, text };
        harness.emit({
          type: eventType,
          turnId,
          payload,
          final: isFinal,
        });
        if (role === "user" && isFinal) {
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: outputTalkPayload,
            final: true,
          });
        }
        if (!isFinal) {
          return;
        }
        params.logger.info(
          formatMeetingTranscriptSummaryLog(
            params.platform.logScope,
            `${realtimeLogScope} ${role}`,
            text,
          ),
        );
        if (role !== "user" || strategy !== "agent") {
          return;
        }
        if (harness.isLikelyAssistantEchoTranscript(text)) {
          params.logger.info(
            formatMeetingTranscriptSummaryLog(
              params.platform.logScope,
              `${realtimeLogScope} ignored assistant echo transcript`,
              text,
            ),
          );
          return;
        }
        if (!stopped) {
          harness.talkback?.enqueue(text);
        }
      },
      onEvent: (event) => {
        if (event.direction === "server" && event.type === "session.created") {
          continuityResetActive = false;
        }
        if (event.direction === "client" && event.type === "session.continuity.reset") {
          if (continuityResetActive) {
            return;
          }
          continuityResetActive = true;
          realtimeReady = false;
          outputOwner.reset();
          outputGenerationActive = false;
          toolContinuity.reset(event.type);
          const turnId = harness.talk.activeTurnId;
          invalidateOutputPlayback();
          harness.flushOutput(outputQueue.clear);
          harness.finishOutputAudio(event.type);
          if (turnId) {
            harness.talk.cancelTurn({
              turnId,
              payload: { ...outputTalkPayload, reason: event.type },
            });
          }
          return;
        }
        outputOwner.noteEvent(event);
        if (event.type === "input_audio_buffer.speech_started") {
          harness.ensureTurn();
        } else if (event.type === "input_audio_buffer.speech_stopped") {
          const turnId = harness.talk.activeTurnId;
          if (!turnId) {
            return;
          }
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: { ...outputTalkPayload, source: event.type },
            final: true,
          });
        } else if (
          event.type === "error" &&
          event.detail === "Cancellation failed: no active response found"
        ) {
          if (outputOwner.clearBlocked()) {
            outputGenerationActive = false;
            harness.finishOutputAudio(event.type);
          }
        } else if (event.type === "error") {
          harness.emit({
            type: "session.error",
            payload: { message: event.detail ?? "Realtime provider error" },
            final: true,
          });
        }
        if (
          event.type === "error" ||
          event.type === "response.done" ||
          event.type === "input_audio_buffer.speech_started" ||
          event.type === "input_audio_buffer.speech_stopped" ||
          event.type === "conversation.item.input_audio_transcription.completed" ||
          event.type === "conversation.item.input_audio_transcription.failed"
        ) {
          const detail = event.detail ? ` ${event.detail}` : "";
          params.logger.info(
            `${params.platform.logScope} ${realtimeLogScope} ${event.direction}:${event.type}${detail}`,
          );
        }
      },
      onResponseDone: (outcome) => {
        if (!outputOwner.terminal(outcome.responseId)) {
          return;
        }
        outputGenerationActive = false;
        if (outcome.status === "failed" || outcome.status === "incomplete") {
          params.logger.warn(
            `${params.platform.logScope} ${realtimeLogScope} response ${outcome.status}: ${outcome.message}`,
          );
        }
      },
      onToolCall: (event, session) => {
        if (stopped) {
          return Promise.resolve();
        }
        return toolContinuity.run({
          session,
          call: {
            strategy,
            event,
            meetingSessionId: params.meetingSessionId,
            requesterSessionKey: params.requesterSessionKey,
            transcript: harness.transcript,
          },
          harness,
        });
      },
      onError: (error) => {
        // Provider errors may be recoverable; onClose owns terminal teardown.
        harness.emit({
          type: "session.error",
          payload: { message: formatErrorMessage(error) },
          final: true,
        });
        params.logger.warn(
          `${params.platform.logScope} ${realtimeLogScope} voice bridge failed: ${formatErrorMessage(error)}`,
        );
      },
      onClose: (reason) => {
        outputGenerationActive = false;
        realtimeReady = false;
        harness.finishOutputAudio(reason);
        harness.emit({
          type: "session.closed",
          payload: { reason },
          final: true,
        });
        stopAfterFailure("voice bridge close");
      },
      onReady: () => {
        realtimeReady = true;
        continuityResetActive = false;
        harness.emit({
          type: "session.ready",
          payload: outputTalkPayload,
        });
      },
    });
    if (bridge.bridge.outputAudioMode === "continuous") {
      requireIsolatedInput();
    }
    startHumanBargeInMonitor();

    // Drain transport input while connect() is pending so the capture pipe never backpressures.
    // Pre-connect audio is forwarded; the voice bridge owns buffering, matching the previous
    // local command-pair behavior.
    params.transport.startInput((audio) => {
      if (stopped || audio.byteLength === 0) {
        return;
      }
      if (!harness.recordInputAudio(audio)) {
        return;
      }
      bridge?.sendAudio(audio);
    });

    await bridge.connect();
    if (stopped) {
      throw new Error(
        `${params.platform.displayName} audio transport stopped during realtime provider setup`,
      );
    }
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      params.logger.debug?.(
        `${params.platform.logScope} ${realtimeLogScope} failed-start cleanup ignored: ${formatErrorMessage(cleanupError)}`,
      );
      try {
        await stop();
      } catch (retryError) {
        params.logger.debug?.(
          `${params.platform.logScope} ${realtimeLogScope} failed-start cleanup retry ignored: ${formatErrorMessage(retryError)}`,
        );
      }
    }
    throw error;
  }

  return {
    providerId: resolved.provider.id,
    speak: (instructions) => {
      bridge?.triggerGreeting(instructions);
    },
    getHealth: () => ({
      ...harness.getHealth({
        providerConnected: bridge?.bridge.isConnected() ?? false,
        realtimeReady,
      }),
      ...(bridge?.bridge.outputAudioMode === "continuous"
        ? { audioOutputActive: outputQueue.hasUnplayedAudibleAudio() }
        : {}),
      ...params.transport.getHealth?.(),
      ...outputQueue.getHealth(),
      bridgeClosed,
    }),
    stop,
  };
}
