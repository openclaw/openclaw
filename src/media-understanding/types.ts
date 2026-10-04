import type { Result } from "@openclaw/normalization-core/result";
import type { MediaUnderstandingCapability } from "../../packages/media-understanding-common/src/types.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ModelProviderRequestTransportOverrides } from "../agents/provider-request-config.types.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Agent-owned runtime handle carried opaquely through media provider requests. */
type MediaPreparedModelRuntime = Readonly<{
  agentDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  createStores: () => unknown;
}>;

export type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingCapabilityRegistry,
  MediaUnderstandingOutput,
} from "../../packages/media-understanding-common/src/types.js";

type MediaUnderstandingDecisionOutcome =
  | "success"
  | "failed"
  | "skipped"
  | "disabled"
  | "no-attachment"
  | "scope-deny";

export type MediaUnderstandingModelDecision = {
  provider?: string;
  model?: string;
  requestedBackend?: string;
  observedBackend?: string;
  type: "provider" | "cli";
  outcome: "success" | "skipped" | "failed";
  reason?: string;
};

type MediaUnderstandingAttachmentDecision = {
  attachmentIndex: number;
  attempts: MediaUnderstandingModelDecision[];
  chosen?: MediaUnderstandingModelDecision;
};

export type MediaAttachmentDisposition =
  | { kind: "handled" }
  | { kind: "handed-to-native-vision" }
  | { kind: "not-selected" }
  | { kind: "capability-disabled" }
  | { kind: "no-model" }
  | { kind: "scope-denied" }
  | { kind: "failed"; reason?: string };

export type MediaAttachmentProcessing = "completed" | "omitted";

export type MediaUnderstandingDecision = {
  capability: MediaUnderstandingCapability;
  outcome: MediaUnderstandingDecisionOutcome;
  attachments: MediaUnderstandingAttachmentDecision[];
  // Optional on the shipped SDK contract: plugins pass FinalizedMsgContext into
  // inbound-reply dispatch and may hold legacy decision literals. Core producers
  // (runner, apply-capability, runtime) always populate it; absence renders no
  // markers rather than breaking plugin compilation.
  attachmentDispositions?: Record<number, MediaAttachmentDisposition>;
  // CLI/provider completion is independent of usable output or a rendered marker.
  // Optional for shipped SDK decision literals; absence means unknown processing.
  attachmentProcessing?: Record<number, MediaAttachmentProcessing>;
  nativeVisionActive?: boolean;
};

export type MediaUnderstandingProviderRequestAuth =
  | { kind: "api-key"; apiKey: string; source?: string }
  | { kind: "none"; source: string };

export type AudioTranscriptionRequest = MediaUnderstandingProviderRequest & {
  language?: string;
  query?: Record<string, string | number | boolean>;
};

type MediaUnderstandingProviderRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  /** Compatibility field for existing providers; prefer auth.kind/apiKey. */
  apiKey: string;
  auth?: MediaUnderstandingProviderRequestAuth;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ModelProviderRequestTransportOverrides;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
};

type MediaUnderstandingTextResult = {
  text: string;
  model?: string;
};

export type AudioTranscriptionResult = MediaUnderstandingTextResult;

type AudioTranscriptionContext = Omit<AudioTranscriptionRequest, "apiKey" | "auth"> & {
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  profile?: string;
  preferredProfile?: string;
};

export type VideoDescriptionRequest = MediaUnderstandingProviderRequest;

export type VideoDescriptionResult = MediaUnderstandingTextResult;

export type ImageDescriptionRequest = ImagesDescriptionInput &
  Omit<ImagesDescriptionRequest, "images">;

export type ImagesDescriptionInput = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
};

export type ImagesDescriptionRequest = {
  images: ImagesDescriptionInput[];
  model: string;
  provider: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  preparedModelRuntime?: MediaPreparedModelRuntime;
  cfg: OpenClawConfig;
};

export type ImageDescriptionResult = MediaUnderstandingTextResult;

export type ImagesDescriptionResult = ImageDescriptionResult;

export type StructuredExtractionTextInput = {
  type: "text";
  text: string;
};

export type StructuredExtractionImageInput = ImagesDescriptionInput & {
  type: "image";
};

export type StructuredExtractionInput =
  | StructuredExtractionTextInput
  | StructuredExtractionImageInput;

export type StructuredExtractionRequest = {
  /** Image-first extraction input; callers must include at least one image. */
  input: StructuredExtractionInput[];
  instructions: string;
  schemaName?: string;
  jsonSchema?: unknown;
  jsonMode?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  profile?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  agentDir: string;
  cfg: OpenClawConfig;
  model: string;
  provider: string;
};

export type StructuredExtractionResult = {
  text: string;
  parsed?: unknown;
  model?: string;
  provider?: string;
  contentType?: "json" | "text";
};

type MediaUnderstandingDocumentModelDefaults = {
  textExtraction?: string;
  image?: string | false;
};

export type MediaUnderstandingProviderAuthContext = {
  config?: OpenClawConfig;
  provider: string;
  providerConfig?: ModelProviderConfig;
};

export type MediaUnderstandingProviderAuthResult =
  | { kind: "none"; source: string }
  | { kind: "api-key"; apiKey: string; source: string; mode?: "api-key" };

export type MediaUnderstandingProviderSyntheticAuthResult = {
  apiKey: string;
  source: string;
  mode: "api-key";
};

export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  defaultModels?: Partial<Record<MediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<MediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: Array<"pdf">;
  documentModels?: Partial<Record<"pdf", MediaUnderstandingDocumentModelDefaults>>;
  resolveAuth?: (
    ctx: MediaUnderstandingProviderAuthContext,
  ) => MediaUnderstandingProviderAuthResult | null | undefined;
  /** @deprecated Use resolveAuth. */
  resolveSyntheticAuth?: (
    ctx: MediaUnderstandingProviderAuthContext,
  ) => MediaUnderstandingProviderSyntheticAuthResult | null | undefined;
  transcribeAudio?: (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult>;
  /** Called after file loading. Result.error is only a rejection before audio upload;
   * upload/HTTP failures must throw and stop automatic provider selection. */
  transcribeAudioWithContext?: (
    req: AudioTranscriptionContext,
  ) => Promise<Result<AudioTranscriptionResult, unknown>>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
  describeImages?: (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;
  extractStructured?: (req: StructuredExtractionRequest) => Promise<StructuredExtractionResult>;
};
