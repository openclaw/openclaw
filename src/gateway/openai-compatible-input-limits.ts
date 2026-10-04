import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
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
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";

const DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_OPENAI_MAX_IMAGE_PARTS = 8;
const DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export type ResolvedOpenAiChatCompletionsLimits = {
  maxBodyBytes: number;
  maxImageParts: number;
  maxTotalImageBytes: number;
  images: InputImageLimits;
};

export function resolveOpenAiChatCompletionsLimits(
  config: GatewayHttpChatCompletionsConfig | undefined,
): ResolvedOpenAiChatCompletionsLimits {
  const imageConfig = config?.images;
  return {
    maxBodyBytes: DEFAULT_OPENAI_CHAT_COMPLETIONS_BODY_BYTES,
    maxImageParts: DEFAULT_OPENAI_MAX_IMAGE_PARTS,
    maxTotalImageBytes: DEFAULT_OPENAI_MAX_TOTAL_IMAGE_BYTES,
    images: {
      allowUrl: imageConfig?.allowUrl ?? false,
      urlAllowlist: normalizeInputHostnameAllowlist(imageConfig?.urlAllowlist),
      allowedMimes: normalizeMimeList(imageConfig?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: imageConfig?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: imageConfig?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: imageConfig?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
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
  const images = config?.images;
  const fileLimits = resolveInputFileLimits(files);
  return {
    maxBodyBytes: DEFAULT_BODY_BYTES,
    maxUrlParts: resolveIntegerOption(config?.maxUrlParts, DEFAULT_MAX_URL_PARTS, { min: 0 }),
    files: {
      ...fileLimits,
      urlAllowlist: normalizeInputHostnameAllowlist(files?.urlAllowlist),
    },
    images: {
      allowUrl: images?.allowUrl ?? true,
      urlAllowlist: normalizeInputHostnameAllowlist(images?.urlAllowlist),
      allowedMimes: normalizeMimeList(images?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: images?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: images?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: images?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}
