import type { Result } from "@openclaw/normalization-core/result";
import type {
  AudioTranscriptionResult,
  ImageDescriptionResult,
  ImagesDescriptionInput,
  ImagesDescriptionResult,
  MediaUnderstandingCapability,
  StructuredExtractionInput,
  StructuredExtractionResult,
  VideoDescriptionResult,
} from "../../packages/media-understanding-common/src/types.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderResolveSyntheticAuthContext } from "../plugins/provider-external-auth.types.js";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProviderAuthResult,
  MediaUnderstandingProviderSyntheticAuthResult,
  PdfAnalysisRequest,
  PdfAnalysisResult,
  VideoDescriptionRequest,
} from "./types.js";

export type AudioTranscriptionConfigContext = Pick<
  AudioTranscriptionRequest,
  "baseUrl" | "headers" | "request" | "model"
> & {
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  profile?: string;
  preferredProfile?: string;
};

type AudioTranscriptionContext = Omit<AudioTranscriptionRequest, "apiKey" | "auth"> &
  AudioTranscriptionConfigContext;

export type ImageDescriptionRequest = ImagesDescriptionInput &
  Omit<ImagesDescriptionRequest, "images">;

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
  /** Agent-owned runtime handle carried opaquely through media provider requests. */
  preparedModelRuntime?: Readonly<{
    agentDir: string;
    workspaceDir?: string;
    config: OpenClawConfig;
    createStores: () => unknown;
  }>;
  cfg: OpenClawConfig;
};

export type StructuredExtractionRequest = Omit<
  ImagesDescriptionRequest,
  "images" | "prompt" | "maxTokens" | "agentId" | "workspaceDir" | "preparedModelRuntime"
> & {
  /** Image-first extraction input; callers must include at least one image. */
  input: StructuredExtractionInput[];
  instructions: string;
  schemaName?: string;
  jsonSchema?: unknown;
  jsonMode?: boolean;
};

type MediaUnderstandingDocumentModelDefaults = {
  textExtraction?: string;
  image?: string | false;
};

export type MediaUnderstandingProviderAuthContext = ProviderResolveSyntheticAuthContext;

export type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];
  /** Add image capability from this request's configured model inputs, not registration config. */
  inheritConfiguredImageCapability?: boolean;
  /** Narrow capability-less shared entries; undefined preserves all effective capabilities. */
  sharedEntryCapabilities?: MediaUnderstandingCapability[];
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
  /** Checks provider-owned credentials and transport settings without uploading audio. */
  isAudioConfigured?: (context: AudioTranscriptionConfigContext) => boolean | Promise<boolean>;
  /** Called after file loading. Result.error is only a rejection before audio upload;
   * upload/HTTP failures must throw and stop automatic provider selection. */
  transcribeAudioWithContext?: (
    req: AudioTranscriptionContext,
  ) => Promise<Result<AudioTranscriptionResult, unknown>>;
  describeVideo?: (req: VideoDescriptionRequest) => Promise<VideoDescriptionResult>;
  describeImage?: (req: ImageDescriptionRequest) => Promise<ImageDescriptionResult>;
  describeImages?: (req: ImagesDescriptionRequest) => Promise<ImagesDescriptionResult>;
  /** Undefined means unsupported before upload. After submission, failures must throw. */
  analyzePdf?: (req: PdfAnalysisRequest) => Promise<PdfAnalysisResult | undefined>;
  extractStructured?: (req: StructuredExtractionRequest) => Promise<StructuredExtractionResult>;
};
