/** Production-private runtime seam for bundled and separately published official plugins. */
export {
  registerRealtimeVoiceSelection,
  type RealtimeVoiceSelectionHandle,
  type RealtimeVoiceSelectionInfo,
  type RealtimeVoiceSelectionRequest,
} from "../talk/voice-selection-control.js";
export type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
export { projectInternalRealtimeVoicePublicConfig } from "../talk/provider-internal.js";
export type {
  OpenAICompatibleRealtimeAudioFormat,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceAudioChunkMetadata,
  RealtimeVoicePlaybackItem,
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceBridgeEvent,
  RealtimeVoiceCloseDisposition,
  RealtimeVoiceCloseOptions,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceCloseReason,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderConfiguredContext,
  RealtimeVoiceProviderResolveConfigContext,
  RealtimeVoiceResponseError,
  RealtimeVoiceResponseOutcome,
  RealtimeVoiceRole,
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
  RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
export {
  normalizeRealtimeVoiceResponseOutcome,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  realtimeVoiceAudioDurationMs,
  toOpenAICompatibleRealtimeAudioFormat,
} from "../talk/provider-types.js";
export { type TalkEvent, type TalkEventInput } from "../talk/talk-events.js";
export { recordTalkObservabilityEvent } from "../talk/observability.js";
export {
  createTalkSessionController,
  type TalkSessionController,
} from "../talk/talk-session-controller.js";
export {
  isSupportedRealtimeVoiceActivationName,
  matchRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
  normalizeSupportedRealtimeVoiceActivationName,
  sortRealtimeVoiceActivationNames,
  type RealtimeVoiceActivationNameTranscriptResult,
} from "../talk/activation-name.js";
export { classifySkippableRealtimeVoiceConsultTranscript } from "../talk/consult-transcript.js";
export {
  matchRealtimeVoiceConsultQuestions,
  readRealtimeVoiceConsultQuestion,
  readSpeakableRealtimeVoiceToolResult,
} from "../talk/consult-question.js";
export {
  createRealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultHandle,
} from "../talk/forced-consult-coordinator.js";
export {
  createRealtimeVoiceTurnContextTracker,
  type RealtimeVoiceTurnContextHandle,
  type RealtimeVoiceTurnContextTracker,
} from "../talk/turn-context-tracker.js";
export {
  createRealtimeVoiceOutputActivityTracker,
  type RealtimeVoiceOutputActivityTracker,
} from "../talk/output-activity-tracker.js";
export {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  buildRealtimeVoiceSessionInstructions,
  isRealtimeVoiceAgentConsultToolPolicy,
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "../talk/agent-consult-tool.js";
export {
  buildRealtimeVoiceSpeakExactMessage,
  classifyRealtimeVoiceConsultToolCall,
} from "../talk/exact-speech-protocol.js";
export {
  isRealtimeVoiceWakeNameRequired,
  resolveRealtimeVoiceBargeIn,
  resolveRealtimeVoiceInterruptResponseOnInputAudio,
  resolveRealtimeVoiceMinBargeInAudioEndMs,
  resolveRealtimeVoiceSessionPolicy,
  type RealtimeVoiceWakeNamePolicy,
} from "../talk/realtime-session-policy.js";
export {
  assertRealtimeVoiceAgentConsultModelSelectionUnlocked,
  consultRealtimeVoiceAgent,
  REALTIME_VOICE_AGENT_CONSULT_SENDER_AUTH_VERSION,
} from "../talk/agent-consult-runtime.js";
export {
  createRealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentTalkbackResult,
} from "../talk/agent-talkback-runtime.js";
export {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentErrorProviderResult,
  controlRealtimeVoiceAgentRun,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_TOOL,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlResult,
} from "../talk/agent-run-control.js";
export {
  resolveRealtimeVoiceFastContextConsult,
  type RealtimeVoiceFastContextConfig,
  type RealtimeVoiceFastContextConsultResult,
} from "../talk/fast-context-runtime.js";
export {
  canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider,
  listRealtimeVoiceProviders,
} from "../talk/provider-registry.js";
export {
  resolveConfiguredRealtimeVoiceProvider,
  type ResolvedRealtimeVoiceProvider,
} from "../talk/provider-resolver.js";
export {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceAudioSink,
  type RealtimeVoiceBridgeSession,
} from "../talk/session-runtime.js";
export {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../talk/realtime-session-harness.js";
export {
  createRealtimeVoiceAudioQueue,
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceSessionConnection,
} from "../talk/realtime-session-lifecycle.js";
export {
  extendRealtimeVoiceOutputEchoSuppression,
  getRealtimeVoiceBridgeEventHealth,
  getRealtimeVoiceTranscriptHealth,
  isLikelyRealtimeVoiceAssistantEchoTranscript,
  recordRealtimeVoiceBridgeEvent,
  recordRealtimeVoiceTranscript,
  type RealtimeVoiceBridgeEventLogEntry,
  type RealtimeVoiceTranscriptEntry,
} from "../talk/session-log-runtime.js";
export {
  calculateMulawRms,
  createSpeechThresholdGate,
  isRealtimeVoiceAudioAudible,
  readPcm16AudioStats,
} from "../talk/audio-energy.js";
export {
  convertPcmToMulaw8k,
  mulawToPcm,
  resamplePcm,
  resamplePcmTo8k,
} from "../talk/audio-codec.js";

export {
  createRealtimeVoiceAudioPortSender,
  type RealtimeVoiceAudioOutputPort,
} from "../talk/audio-output-port.js";
