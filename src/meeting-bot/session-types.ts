import type { MeetingAudioBackend } from "./audio-backend.js";
import type { MeetingOutputLoopbackHealth } from "./output-loopback-verifier.js";

/** Generic lifecycle state shared by browser and dial-in meeting sessions. */
export type MeetingSessionState = "active" | "ended";

export type MeetingResolvedJoin<TTransport extends string, TMode extends string> = {
  url: string;
  transport: TTransport;
  mode: TMode;
  agentId: string;
};

/** Descriptive facts for one retained observation, never participation authority. */
export type MeetingObservationProvenance = {
  observer: string;
  observationId?: string;
  sessionId?: string;
  epoch?: string;
  observedAt?: string;
  speaker?: string;
  self: "self" | "other" | "unknown";
};

export type MeetingTranscriptLine = {
  at?: string;
  speaker?: string;
  text: string;
  /** Independent of the optional, mutable action-source identity below. */
  provenance?: MeetingObservationProvenance;
  /** Optional identity assigned by the provider's canonical caption observer. */
  source?: {
    id: string;
    epoch: string;
    revision: string;
    finalized: boolean;
    /** Undefined means the provider could not establish whether this is our own speech. */
    ownEcho?: boolean;
  };
};

export type MeetingTranscriptSnapshot = {
  droppedLines: number;
  epoch?: string;
  lines: MeetingTranscriptLine[];
  /** Live caption revisions for observation only; never append these to the transcript. */
  pendingLines?: MeetingTranscriptLine[];
};

export type MeetingBrowserTab = {
  targetId: string;
  openedByPlugin: boolean;
};

export type MeetingBrowserCandidateTab = {
  targetId?: string;
  title?: string;
  url?: string;
};

export type MeetingBrowserHealth<
  TManualReason extends string = string,
  TSpeechBlockedReason extends string = string,
> = Partial<MeetingOutputLoopbackHealth> & {
  inCall?: boolean;
  micMuted?: boolean;
  manualAction?: { reason: TManualReason; message: string };
  speechReady?: boolean;
  speechBlockedReason?: TSpeechBlockedReason;
  speechBlockedMessage?: string;
};

export type MeetingPluginProbeHealth = MeetingBrowserHealth & {
  audioOutputActive?: boolean;
  captioning?: boolean;
  captionsEnabledAttempted?: boolean;
  lastCaptionAt?: string;
  lastCaptionSpeaker?: string;
  lastCaptionText?: string;
  lastOutputBytes?: number;
  recentTranscript?: MeetingTranscriptLine[];
  transcriptLines?: number;
};

export type MeetingRealtimeSessionBlock = {
  enabled: boolean;
  strategy?: string;
  provider?: string;
  model?: string;
  transcriptionProvider?: string;
  toolPolicy: string;
};

/**
 * Stable shared wire fields. Platform adapters add thin browser and dial-in blocks
 * under their existing public field names so migrations do not reshape JSON.
 */
export type MeetingSessionRecord<
  TTransport extends string = string,
  TMode extends string = string,
  TRealtime extends MeetingRealtimeSessionBlock = MeetingRealtimeSessionBlock,
> = {
  id: string;
  url: string;
  transport: TTransport;
  mode: TMode;
  agentId: string;
  state: MeetingSessionState;
  transcriptEvicted?: boolean;
  browserLeft?: boolean;
  createdAt: string;
  updatedAt: string;
  participantIdentity: string;
  realtime: TRealtime;
  notes: string[];
};

export type MeetingPluginJoinRequest<TTransport extends string, TMode extends string> = {
  url: string;
  transport?: TTransport;
  mode?: TMode;
  message?: string;
  requesterSessionKey?: string;
  agentId?: string;
  timeoutMs?: number;
};

export type MeetingPluginChromeHealth<
  TManualReason extends string,
  TSpeechBlockedReason extends string,
> = MeetingBrowserHealth<TManualReason, TSpeechBlockedReason> &
  MeetingPluginProbeHealth & {
    cameraOff?: boolean;
    lobbyWaiting?: boolean;
    captionCaptureRequested?: boolean;
    audioInputRouted?: boolean;
    audioInputDeviceLabel?: string;
    audioInputRouteError?: string;
    audioOutputRouted?: boolean;
    audioOutputDeviceLabel?: string;
    audioOutputRouteError?: string;
    audioOutputRouteRetryable?: boolean;
    providerConnected?: boolean;
    realtimeReady?: boolean;
    audioInputActive?: boolean;
    lastInputAt?: string;
    lastOutputAt?: string;
    lastInputBytes?: number;
    bridgeClosed?: boolean;
    browserUrl?: string;
    browserTitle?: string;
    status?: string;
    notes?: string[];
  };

export type MeetingPluginSession<
  TTransport extends string,
  TMode extends string,
  THealth extends MeetingBrowserHealth,
> = MeetingSessionRecord<TTransport, TMode> & {
  chrome?: {
    audioBackend?: MeetingAudioBackend;
    launched: boolean;
    nodeId?: string;
    browserProfile?: string;
    browserTab?: MeetingBrowserTab;
    audioBridge?: {
      type: "command-pair" | "node-command-pair";
      provider?: string;
    };
    health?: THealth;
  };
};

export type MeetingPluginJoinResult<TSession> = { session: TSession; spoken?: boolean };
