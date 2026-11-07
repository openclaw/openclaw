import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
import type {
  ImageDescriptionResult,
  ImagesDescriptionInput,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  StructuredExtractionResult,
} from "../../packages/media-understanding-common/src/types.js";
// Public media-understanding runtime API types for file-based image/audio/video
// helpers and direct structured extraction.
import type { OpenClawConfig } from "../config/types.js";
import type { StructuredExtractionRequest } from "./provider-types.js";

export type RunMediaUnderstandingFileParams = {
  capability: "image" | "audio" | "video";
  filePath: string;
  mediaUrl?: string;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  mime?: string;
  activeModel?: ActiveMediaModel;
  prompt?: string;
  timeoutMs?: number;
  scopeContext?: {
    sessionKey?: string;
    channel?: string;
    chatType?: string;
  };
};

export type RunMediaUnderstandingFileResult = {
  text: string | undefined;
  provider?: string;
  model?: string;
  output?: MediaUnderstandingOutput;
  decision?: MediaUnderstandingDecision;
};

export type DescribeImageFileParams = Omit<RunMediaUnderstandingFileParams, "capability">;

export type DescribeImageFileWithModelParams = Omit<
  RunMediaUnderstandingFileParams,
  "capability" | "activeModel" | "scopeContext" | "prompt"
> & {
  provider: string;
  model: string;
  prompt: string;
  maxTokens?: number;
};

export type PrepareImageDescriptionInputParams = Pick<
  DescribeImageFileWithModelParams,
  "filePath" | "mediaUrl" | "mime" | "cfg" | "timeoutMs"
>;

export type DescribePreparedImageWithModelParams = Omit<
  DescribeImageFileWithModelParams,
  "filePath" | "mediaUrl" | "mime"
> & {
  image: ImagesDescriptionInput;
};

export type ExtractStructuredWithModelParams = Omit<
  StructuredExtractionRequest,
  "input" | "agentDir" | "signal" | "timeoutMs"
> & {
  /** At least one image input is required; text inputs provide supplemental context. */
  input: StructuredExtractionRequest["input"];
  agentDir?: string;
  timeoutMs?: number;
};

export type DescribeVideoFileParams = Omit<
  DescribeImageFileParams,
  "mediaUrl" | "prompt" | "timeoutMs" | "scopeContext"
> & {
  /** Try this model first, retaining configured media model fallbacks. */
  modelOverride?: ProviderModelRef;
};

export type TranscribeAudioFileParams = DescribeVideoFileParams & {
  language?: string;
  prompt?: string;
};

export type MediaUnderstandingRuntime = {
  resolveAudioInputBudget: (params: {
    cfg: OpenClawConfig;
  }) => Promise<{ enabled: false } | { enabled: true; maxBytes: number }>;
  runMediaUnderstandingFile: (
    params: RunMediaUnderstandingFileParams,
  ) => Promise<RunMediaUnderstandingFileResult>;
  describeImageFile: (params: DescribeImageFileParams) => Promise<RunMediaUnderstandingFileResult>;
  prepareImageDescriptionInput: (
    params: PrepareImageDescriptionInputParams,
  ) => Promise<ImagesDescriptionInput>;
  describePreparedImageWithModel: (
    params: DescribePreparedImageWithModelParams,
  ) => Promise<ImageDescriptionResult>;
  describeImageFileWithModel: (
    params: DescribeImageFileWithModelParams,
  ) => Promise<ImageDescriptionResult>;
  extractStructuredWithModel: (
    params: ExtractStructuredWithModelParams,
  ) => Promise<StructuredExtractionResult>;
  describeVideoFile: (params: DescribeVideoFileParams) => Promise<RunMediaUnderstandingFileResult>;
  transcribeAudioFile: (
    params: TranscribeAudioFileParams,
  ) => Promise<RunMediaUnderstandingFileResult>;
};
