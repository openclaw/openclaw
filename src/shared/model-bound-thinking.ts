// Model-bound thinking cannot be exposed or replayed after a model switch.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type ReplayModelRef = {
  provider?: string;
  api?: string;
  modelId?: string;
};

function normalizeModelId(modelId?: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.startsWith("anthropic/") ? normalized.slice("anthropic/".length) : normalized;
}

function isClaudeFable5(ref: ReplayModelRef): boolean {
  const provider = normalizeLowercaseStringOrEmpty(ref.provider);
  return (
    (provider === "anthropic" || provider === "anthropic-vertex") &&
    normalizeModelId(ref.modelId).startsWith("claude-fable-5")
  );
}

function normalizeApi(api?: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(api);
  return normalized === "openclaw-anthropic-messages-transport" ? "anthropic-messages" : normalized;
}

export function resolveModelBoundThinkingReplayMode(params: {
  source: ReplayModelRef;
  target: ReplayModelRef;
}): "default" | "preserve" | "drop" {
  const sourceIsFable = isClaudeFable5(params.source);
  const targetIsFable = isClaudeFable5(params.target);
  if (!sourceIsFable && !targetIsFable) {
    return "default";
  }
  const sameModel =
    sourceIsFable &&
    targetIsFable &&
    normalizeApi(params.source.api) === normalizeApi(params.target.api) &&
    normalizeModelId(params.source.modelId) === normalizeModelId(params.target.modelId);
  return sameModel ? "preserve" : "drop";
}
