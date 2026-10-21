import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type {
  GatewayHttpChatCompletionsConfig,
  GatewayHttpResponsesConfig,
} from "../config/types.gateway.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  normalizeMimeList,
  resolveInputFileLimits,
  type InputFileLimits,
  type InputImageLimits,
} from "../media/input-files.js";

const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export type ResolvedOpenAiChatCompletionsLimits = {
  maxBodyBytes: number;
  maxImageParts: number;
  maxTotalImageBytes: number;
  images: InputImageLimits;
};

function resolveImageLimits(
  config: GatewayHttpResponsesConfig["images"],
  allowUrl: boolean,
): InputImageLimits {
  return {
    allowUrl: config?.allowUrl ?? allowUrl,
    urlAllowlist: normalizeOptionalTrimmedStringList(config?.urlAllowlist),
    allowedMimes: normalizeMimeList(config?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
    maxBytes: config?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
    maxRedirects: config?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
    timeoutMs: config?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
  };
}

export function resolveOpenAiChatCompletionsLimits(
  config: GatewayHttpChatCompletionsConfig | undefined,
): ResolvedOpenAiChatCompletionsLimits {
  return {
    maxBodyBytes: DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts: DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes: DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
    images: resolveImageLimits(config?.images, false),
  };
}

const DEFAULT_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_URL_PARTS = 8;

type ResolvedResponsesLimits = {
  maxBodyBytes: number;
  maxUrlParts: number;
  files: InputFileLimits;
  images: InputImageLimits;
};

export function resolveResponsesLimits(
  config: GatewayHttpResponsesConfig | undefined,
): ResolvedResponsesLimits {
  const files = config?.files;
  const fileLimits = resolveInputFileLimits(files);
  return {
    maxBodyBytes: DEFAULT_BODY_BYTES,
    maxUrlParts: resolveIntegerOption(config?.maxUrlParts, DEFAULT_MAX_URL_PARTS, { min: 0 }),
    files: {
      ...fileLimits,
      urlAllowlist: normalizeOptionalTrimmedStringList(files?.urlAllowlist),
    },
    images: resolveImageLimits(config?.images, true),
  };
}
