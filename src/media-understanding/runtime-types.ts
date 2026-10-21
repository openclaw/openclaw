import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
// Public media-understanding runtime API types for file-based image/audio/video
// helpers and direct structured extraction.
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
  ImagesDescriptionInput,
  StructuredExtractionRequest,
} from "./types.js";

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
  scopeContext?: MediaUnderstandingScopeContext;
};

type MediaUnderstandingScopeContext = {
  sessionKey?: string;
  channel?: string;
  chatType?: string;
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

export type PreparedImageDescriptionInput = ImagesDescriptionInput;

export type PrepareImageDescriptionInputParams = Pick<
  DescribeImageFileWithModelParams,
  "filePath" | "mediaUrl" | "mime" | "cfg" | "timeoutMs"
>;

export type DescribePreparedImageWithModelParams = Omit<
  DescribeImageFileWithModelParams,
  "filePath" | "mediaUrl" | "mime"
> & {
  image: PreparedImageDescriptionInput;
};

type DescribeImageFileWithModelResult = Awaited<
  ReturnType<NonNullable<MediaUnderstandingProvider["describeImage"]>>
>;

export type ExtractStructuredWithModelParams = Omit<
  StructuredExtractionRequest,
  "input" | "agentDir" | "signal" | "timeoutMs"
> & {
  /** At least one image input is required; text inputs provide supplemental context. */
  input: StructuredExtractionRequest["input"];
  agentDir?: string;
  timeoutMs?: number;
};

type ExtractStructuredWithModelResult = Awaited<
  ReturnType<NonNullable<MediaUnderstandingProvider["extractStructured"]>>
>;

export type DescribeVideoFileParams = Omit<
  DescribeImageFileParams,
  "mediaUrl" | "prompt" | "timeoutMs" | "scopeContext"
>;

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
  ) => Promise<PreparedImageDescriptionInput>;
  describePreparedImageWithModel: (
    params: DescribePreparedImageWithModelParams,
  ) => Promise<DescribeImageFileWithModelResult>;
  describeImageFileWithModel: (
    params: DescribeImageFileWithModelParams,
  ) => Promise<DescribeImageFileWithModelResult>;
  extractStructuredWithModel: (
    params: ExtractStructuredWithModelParams,
  ) => Promise<ExtractStructuredWithModelResult>;
  describeVideoFile: (params: DescribeVideoFileParams) => Promise<RunMediaUnderstandingFileResult>;
  transcribeAudioFile: (
    params: TranscribeAudioFileParams,
  ) => Promise<RunMediaUnderstandingFileResult>;
};
