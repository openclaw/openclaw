import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatMediaSize } from "../../media/store.shared.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import { coerceToolModelConfig, type ToolModelConfig } from "./model-config.helpers.js";

export type ImageModelConfig = ToolModelConfig;

/** Decodes a base64 image data URL with optional decoded-size protection. */
export function decodeDataUrl(
  dataUrl: string,
  opts?: { maxBytes?: number },
): {
  buffer: Buffer;
  mimeType: string;
  kind: "image";
} {
  const trimmed = dataUrl.trim();
  // Capturing the full payload can exhaust the RegExp stack before the size guard.
  const match = /^data:([^;,]+);base64,/i.exec(trimmed);
  const b64 = match ? trimmed.slice(match[0].length) : "";
  if (!match || !b64 || /[^a-z0-9+/=\r\n]/i.test(b64)) {
    throw new Error("Invalid data URL (expected base64 data: URL).");
  }
  const mimeType = normalizeLowercaseStringOrEmpty(match[1]);
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
  }
  const estimatedBytes = estimateBase64DecodedBytes(b64);
  if (typeof opts?.maxBytes === "number" && estimatedBytes > opts.maxBytes) {
    // Estimate before decoding so oversized inline payloads do not allocate large buffers.
    throw new Error(
      `Invalid data URL: payload exceeds size limit (${formatMediaSize(estimatedBytes)}, limit ${formatMediaSize(opts.maxBytes)}).`,
    );
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length === 0) {
    throw new Error("Invalid data URL: empty payload.");
  }
  return { buffer, mimeType, kind: "image" };
}

export function coerceImageModelConfig(cfg?: OpenClawConfig): ImageModelConfig {
  return coerceToolModelConfig(cfg?.agents?.defaults?.imageModel);
}

function resolveProviderlessConfiguredImageModelRef(params: {
  cfg?: OpenClawConfig;
  ref: string;
}): string {
  const ref = params.ref.trim();
  if (!ref || ref.includes("/")) {
    return ref;
  }

  const providers = params.cfg?.models?.providers;
  const matchedRefs = new Set<string>();
  for (const [providerKey, providerConfig] of Object.entries(providers ?? {})) {
    const provider = normalizeProviderId(providerKey);
    if (!provider || !Array.isArray(providerConfig?.models)) {
      continue;
    }
    for (const entry of providerConfig.models) {
      const modelId = entry?.id?.trim();
      if (!modelId || !Array.isArray(entry?.input) || !entry.input.includes("image")) {
        continue;
      }
      const candidates = [modelId];
      const slash = modelId.indexOf("/");
      if (slash > 0 && normalizeProviderId(modelId.slice(0, slash)) === provider) {
        candidates.push(modelId.slice(slash + 1));
      }
      const normalizedRef = normalizeLowercaseStringOrEmpty(ref);
      if (
        !candidates.some(
          (candidate) => normalizeLowercaseStringOrEmpty(candidate) === normalizedRef,
        )
      ) {
        continue;
      }
      matchedRefs.add(
        slash > 0 && normalizeProviderId(modelId.slice(0, slash)) === provider
          ? modelId
          : `${provider}/${modelId}`,
      );
    }
  }
  const matches = [...matchedRefs];
  if (matches.length <= 1) {
    return matches.at(0) ?? ref;
  }
  throw new Error(
    `Ambiguous image model "${ref}". Configure a provider-prefixed ref such as ${matches
      .map((match) => `"${match}"`)
      .join(" or ")}.`,
  );
}

export function resolveConfiguredImageModelRefs(params: {
  cfg?: OpenClawConfig;
  imageModelConfig: ImageModelConfig;
}): ImageModelConfig {
  const primary = params.imageModelConfig.primary?.trim();
  const fallbacks = params.imageModelConfig.fallbacks
    ?.map((ref) => resolveProviderlessConfiguredImageModelRef({ cfg: params.cfg, ref }))
    .filter((ref) => ref.length > 0);

  return {
    ...(params.imageModelConfig.primary !== undefined
      ? {
          primary: primary
            ? resolveProviderlessConfiguredImageModelRef({ cfg: params.cfg, ref: primary })
            : primary,
        }
      : {}),
    ...(fallbacks && fallbacks.length > 0 ? { fallbacks } : {}),
    ...(params.imageModelConfig.timeoutMs !== undefined
      ? { timeoutMs: params.imageModelConfig.timeoutMs }
      : {}),
  };
}

export function resolveProviderVisionModelFromConfig(params: {
  cfg?: OpenClawConfig;
  provider: string;
}): string | null {
  if (isMinimaxVlmProvider(params.provider)) {
    return null;
  }
  const providerCfg = findNormalizedProviderValue(params.cfg?.models?.providers, params.provider);
  const models = providerCfg?.models ?? [];
  const picked = models.find((m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image"));
  const id = (picked?.id ?? "").trim();
  if (!id) {
    return null;
  }
  const slash = id.indexOf("/");
  const idProvider = slash === -1 ? "" : normalizeLowercaseStringOrEmpty(id.slice(0, slash));
  const selectedProvider = normalizeLowercaseStringOrEmpty(params.provider);
  return idProvider && idProvider === selectedProvider ? id : `${params.provider}/${id}`;
}
