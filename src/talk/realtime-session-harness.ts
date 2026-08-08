import type { RealtimeVoiceAgentTalkbackQueue } from "./agent-talkback-runtime.js";
import {
  createRealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentTalkbackQueueParams,
} from "./agent-talkback-runtime.js";
import {
  createRealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinatorOptions,
} from "./forced-consult-coordinator.js";
import { recordTalkObservabilityEvent } from "./observability.js";
import {
  createRealtimeVoiceOutputActivityTracker,
  type RealtimeVoiceOutputActivityDelta,
  type RealtimeVoiceOutputActivityTracker,
} from "./output-activity-tracker.js";
import type { RealtimeVoiceBargeInOptions, RealtimeVoiceRole } from "./provider-types.js";
import {
  extendRealtimeVoiceOutputEchoSuppression,
  getRealtimeVoiceBridgeEventHealth,
  getRealtimeVoiceTranscriptHealth,
  isLikelyRealtimeVoiceAssistantEchoTranscript,
  recordRealtimeVoiceBridgeEvent,
  recordRealtimeVoiceTranscript,
  type RealtimeVoiceBridgeEventLogEntry,
  type RealtimeVoiceTranscriptEntry,
} from "./session-log-runtime.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSessionParams,
} from "./session-runtime.js";
import type { TalkEvent, TalkEventInput } from "./talk-events.js";
import {
  createTalkSessionController,
  type TalkEnsureTurnResult,
  type TalkSessionController,
  type TalkSessionControllerParams,
  type TalkTurnResult,
} from "./talk-session-controller.js";

type RealtimeVoiceSessionHarnessTalkPayloads = {
  turnStarted: () => unknown;
  turnEnded: (reason: string) => unknown;
  inputAudioDelta: (audio: Buffer) => unknown;
  outputAudioStarted: () => unknown;
  outputAudioDelta: (audio: Buffer) => unknown;
  outputAudioDone: (reason: string, details?: RealtimeVoiceOutputAudioDoneDetails) => unknown;
};

type RealtimeVoiceOutputAudioDoneDetails = {
  markName?: string;
};

type RealtimeVoiceSessionHarnessEchoSuppression = {
  bytesPerMs: number;
  tailMs: number;
  transcriptLookbackMs: number;
};

type RealtimeVoiceSessionHarnessHealth = ReturnType<typeof getRealtimeVoiceTranscriptHealth> &
  Partial<ReturnType<typeof getRealtimeVoiceBridgeEventHealth>> & {
    providerConnected: boolean;
    realtimeReady: boolean;
    audioInputActive: boolean;
    audioOutputActive: boolean;
    lastInputAt?: string;
    lastOutputAt?: string;
    lastSuppressedInputAt?: string;
    lastInputBytes: number;
    lastOutputBytes: number;
    suppressedInputBytes: number;
    recentTalkEvents: Array<{
      id: string;
      type: TalkEvent["type"];
      sessionId: string;
      turnId?: string;
      seq: number;
      timestamp: string;
      final?: boolean;
    }>;
  };

type RealtimeVoiceInputAudioEvents = {
  inputAudioDelta: TalkEvent;
  turn: TalkEnsureTurnResult;
};

type RealtimeVoiceOutputAudioEvents = {
  outputAudioDelta: TalkEvent;
  outputAudioStarted?: TalkEvent;
  turn: TalkEnsureTurnResult;
};

type RealtimeVoiceSessionHarnessBase<TForcedConsultContext> = {
  readonly forcedConsults: RealtimeVoiceForcedConsultCoordinator<TForcedConsultContext>;
  readonly outputActivity: RealtimeVoiceOutputActivityTracker;
  readonly talk: TalkSessionController;
  readonly talkback: RealtimeVoiceAgentTalkbackQueue | undefined;
  readonly transcript: RealtimeVoiceTranscriptEntry[];
  close(): void;
  createBridge(params: RealtimeVoiceBridgeSessionParams): RealtimeVoiceBridgeSession;
  emit<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
  flushOutput(flush: () => void): void;
  getHealth(params: {
    providerConnected: boolean;
    realtimeReady: boolean;
  }): RealtimeVoiceSessionHarnessHealth;
  handleBargeIn(options: RealtimeVoiceBargeInOptions, flushOutput: () => void): void;
  isLikelyAssistantEchoTranscript(text: string): boolean;
  isOutputPlaybackWindowActive(): boolean;
  recordTranscript(role: RealtimeVoiceRole, text: string): RealtimeVoiceTranscriptEntry;
};

type RealtimeVoiceSessionHarnessMethods<TReturnEvents extends boolean> = {
  ensureTurn(): TReturnEvents extends true ? TalkEnsureTurnResult : string;
  endTurn(reason?: string): TReturnEvents extends true ? TalkTurnResult : void;
  finishOutputAudio(
    reason: string,
    details?: RealtimeVoiceOutputAudioDoneDetails,
  ): TReturnEvents extends true ? TalkEvent | undefined : void;
  recordInputAudio(
    audio: Buffer,
  ): TReturnEvents extends true ? RealtimeVoiceInputAudioEvents | undefined : boolean;
  recordOutputAudio(
    audio: Buffer,
    activity?: RealtimeVoiceOutputActivityDelta,
  ): TReturnEvents extends true ? RealtimeVoiceOutputAudioEvents : void;
};

export type RealtimeVoiceSessionHarness<
  TForcedConsultContext = unknown,
  TReturnEvents extends boolean = false,
> = RealtimeVoiceSessionHarnessBase<TForcedConsultContext> &
  RealtimeVoiceSessionHarnessMethods<TReturnEvents>;

type RealtimeVoiceSessionHarnessImplementation<TForcedConsultContext> =
  RealtimeVoiceSessionHarnessBase<TForcedConsultContext> & {
    ensureTurn(): string | TalkEnsureTurnResult;
    endTurn(reason?: string): TalkTurnResult | undefined;
    finishOutputAudio(
      reason: string,
      details?: RealtimeVoiceOutputAudioDoneDetails,
    ): TalkEvent | undefined;
    recordInputAudio(audio: Buffer): boolean | RealtimeVoiceInputAudioEvents | undefined;
    recordOutputAudio(
      audio: Buffer,
      activity?: RealtimeVoiceOutputActivityDelta,
    ): RealtimeVoiceOutputAudioEvents | undefined;
  };

type RealtimeVoiceSessionHarnessParams = {
  talk: TalkSessionControllerParams;
  talkPayloads: RealtimeVoiceSessionHarnessTalkPayloads;
  onTalkEvent?: (event: TalkEvent) => void;
  talkback?: Omit<RealtimeVoiceAgentTalkbackQueueParams, "isStopped">;
  forcedConsults?: RealtimeVoiceForcedConsultCoordinatorOptions;
  echoSuppression?: RealtimeVoiceSessionHarnessEchoSuppression;
  transcriptLookbackMs?: number;
  captureBridgeEvents?: boolean;
};

export function createRealtimeVoiceSessionHarness<TForcedConsultContext = unknown>(
  params: RealtimeVoiceSessionHarnessParams & { returnEvents: true },
): RealtimeVoiceSessionHarness<TForcedConsultContext, true>;
export function createRealtimeVoiceSessionHarness<TForcedConsultContext = unknown>(
  params: RealtimeVoiceSessionHarnessParams & { returnEvents?: false },
): RealtimeVoiceSessionHarness<TForcedConsultContext>;
export function createRealtimeVoiceSessionHarness<TForcedConsultContext = unknown>(
  params: RealtimeVoiceSessionHarnessParams & { returnEvents?: boolean },
):
  | RealtimeVoiceSessionHarness<TForcedConsultContext>
  | RealtimeVoiceSessionHarness<TForcedConsultContext, true> {
  let closed = false;
  let bridge: RealtimeVoiceBridgeSession | undefined;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastSuppressedInputAt: string | undefined;
  let lastInputBytes = 0;
  let suppressedInputBytes = 0;
  let suppressInputUntilMs = 0;
  let lastOutputPlayableUntilMs = 0;
  let outputFlushGeneration = 0;
  const transcript: RealtimeVoiceTranscriptEntry[] = [];
  const bridgeEvents: RealtimeVoiceBridgeEventLogEntry[] = [];
  const outputActivity = createRealtimeVoiceOutputActivityTracker();
  const transcriptLookbackMs =
    params.transcriptLookbackMs ?? params.echoSuppression?.transcriptLookbackMs;
  const forcedConsults = createRealtimeVoiceForcedConsultCoordinator<TForcedConsultContext>(
    params.forcedConsults,
  );
  const talk = createTalkSessionController(
    { maxRecentEvents: 40, ...params.talk },
    {
      onEvent: (event) => {
        recordTalkObservabilityEvent(event);
        params.onTalkEvent?.(event);
      },
    },
  );
  const talkback = params.talkback
    ? createRealtimeVoiceAgentTalkbackQueue({
        ...params.talkback,
        isStopped: () => closed,
      })
    : undefined;

  const ensureTurnWithEvents = () =>
    talk.ensureTurn({ payload: params.talkPayloads.turnStarted() });

  const flushOutput = (flush: () => void): void => {
    outputFlushGeneration += 1;
    suppressInputUntilMs = 0;
    lastOutputPlayableUntilMs = 0;
    flush();
  };

  const harness: RealtimeVoiceSessionHarnessImplementation<TForcedConsultContext> = {
    forcedConsults,
    outputActivity,
    talk,
    talkback,
    transcript,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      talkback?.close();
      forcedConsults.clear();
    },
    createBridge(bridgeParams) {
      bridge = createRealtimeVoiceBridgeSession({
        ...bridgeParams,
        onTranscript: (role, text, isFinal) => {
          if (isFinal) {
            harness.recordTranscript(role, text);
          }
          bridgeParams.onTranscript?.(role, text, isFinal);
        },
        onEvent: (event) => {
          if (params.captureBridgeEvents !== false) {
            recordRealtimeVoiceBridgeEvent(bridgeEvents, event);
          }
          bridgeParams.onEvent?.(event);
        },
      });
      return bridge;
    },
    emit: (input) => talk.emit(input),
    ensureTurn() {
      const result = ensureTurnWithEvents();
      return params.returnEvents ? result : result.turnId;
    },
    endTurn(reason = "completed") {
      const result = talk.endTurn({ payload: params.talkPayloads.turnEnded(reason) });
      return params.returnEvents ? result : undefined;
    },
    finishOutputAudio(reason, details) {
      const result = talk.finishOutputAudio({
        payload: params.talkPayloads.outputAudioDone(reason, details),
      });
      return params.returnEvents ? result : undefined;
    },
    flushOutput,
    getHealth(healthParams) {
      const output = outputActivity.snapshot();
      return {
        providerConnected: healthParams.providerConnected,
        realtimeReady: healthParams.realtimeReady,
        audioInputActive: lastInputBytes > 0,
        audioOutputActive: outputActivity.isActive(),
        lastInputAt,
        lastOutputAt,
        lastSuppressedInputAt,
        lastInputBytes,
        lastOutputBytes: output.sinkAudioBytes,
        suppressedInputBytes,
        ...getRealtimeVoiceTranscriptHealth(transcript),
        ...(bridge ? getRealtimeVoiceBridgeEventHealth(bridgeEvents) : {}),
        recentTalkEvents: talk.recentEvents.slice(-20).map((event) => ({
          id: event.id,
          type: event.type,
          sessionId: event.sessionId,
          turnId: event.turnId,
          seq: event.seq,
          timestamp: event.timestamp,
          final: event.final,
        })),
      };
    },
    handleBargeIn(options, fallbackFlush) {
      suppressInputUntilMs = 0;
      const flushGeneration = outputFlushGeneration;
      bridge?.handleBargeIn(options);
      if (flushGeneration === outputFlushGeneration) {
        flushOutput(fallbackFlush);
      }
    },
    isLikelyAssistantEchoTranscript(text) {
      return transcriptLookbackMs === undefined
        ? false
        : isLikelyRealtimeVoiceAssistantEchoTranscript({
            transcript,
            text,
            lookbackMs: transcriptLookbackMs,
          });
    },
    isOutputPlaybackWindowActive() {
      return Date.now() <= Math.max(lastOutputPlayableUntilMs, suppressInputUntilMs);
    },
    recordInputAudio(audio: Buffer) {
      if (Date.now() < suppressInputUntilMs) {
        lastSuppressedInputAt = new Date().toISOString();
        suppressedInputBytes += audio.byteLength;
        return params.returnEvents ? undefined : false;
      }
      lastInputAt = new Date().toISOString();
      lastInputBytes += audio.byteLength;
      const turn = ensureTurnWithEvents();
      const inputAudioDelta = harness.emit({
        type: "input.audio.delta",
        turnId: turn.turnId,
        payload: params.talkPayloads.inputAudioDelta(audio),
      });
      return params.returnEvents ? { inputAudioDelta, turn } : true;
    },
    recordOutputAudio(audio: Buffer, activity: RealtimeVoiceOutputActivityDelta = {}) {
      const turn = ensureTurnWithEvents();
      const output = talk.startOutputAudio({
        turnId: turn.turnId,
        payload: params.talkPayloads.outputAudioStarted(),
      });
      const outputAudioDelta = harness.emit({
        type: "output.audio.delta",
        turnId: turn.turnId,
        payload: params.talkPayloads.outputAudioDelta(audio),
      });
      let audioMs = activity.audioMs;
      if (params.echoSuppression) {
        const suppression = extendRealtimeVoiceOutputEchoSuppression({
          audio,
          bytesPerMs: params.echoSuppression.bytesPerMs,
          tailMs: params.echoSuppression.tailMs,
          nowMs: Date.now(),
          lastOutputPlayableUntilMs,
          suppressInputUntilMs,
        });
        lastOutputPlayableUntilMs = suppression.lastOutputPlayableUntilMs;
        suppressInputUntilMs = suppression.suppressInputUntilMs;
        audioMs ??= suppression.durationMs;
      }
      outputActivity.markAudio({
        audioMs,
        sourceAudioBytes: activity.sourceAudioBytes ?? audio.byteLength,
        sinkAudioBytes: activity.sinkAudioBytes ?? audio.byteLength,
      });
      lastOutputAt = new Date().toISOString();
      return params.returnEvents
        ? {
            outputAudioDelta,
            ...(output.event ? { outputAudioStarted: output.event } : {}),
            turn,
          }
        : undefined;
    },
    recordTranscript: (role, text) => recordRealtimeVoiceTranscript(transcript, role, text),
  };

  return harness as
    | RealtimeVoiceSessionHarness<TForcedConsultContext>
    | RealtimeVoiceSessionHarness<TForcedConsultContext, true>;
}
