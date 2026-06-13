// Provider-specific media capability facts observed outside unreliable user config.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeMediaProviderId } from "./provider-id.js";

function isQwenCloudProvider(providerId: string): boolean {
  return ["qwen", "qwencloud", "modelstudio", "dashscope"].includes(providerId);
}

export function isKnownNonImageModel(params: { providerId: string; modelId: string }): boolean {
  const providerId = normalizeMediaProviderId(params.providerId);
  const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
  return isQwenCloudProvider(providerId) && /^qwen3\.7-max(?:$|[-.])/.test(modelId);
}

export function configuredModelInputSupportsImage(params: {
  providerId: string;
  modelId: string;
  input?: readonly string[];
}): boolean {
  return (
    Array.isArray(params.input) && params.input.includes("image") && !isKnownNonImageModel(params)
  );
}
