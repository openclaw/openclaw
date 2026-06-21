// Model-bound thinking cannot be exposed or replayed after a model switch.
import { resolveClaudeFable5ModelIdentity, resolveClaudeModelIdentity } from "@openclaw/llm-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
export {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeNativeThinkingLevelMap,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "@openclaw/llm-core";

type ReplayModelRef = {
  provider?: string;
  api?: string;
  modelId?: string;
  responseModelId?: string;
  modelParams?: Record<string, unknown>;
};

function normalizeModelId(modelId?: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  const unprefixed = normalized.startsWith("anthropic/")
    ? normalized.slice("anthropic/".length)
    : normalized;
  return unprefixed.replace(/[._\s]+/g, "-");
}

function normalizeApi(api?: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(api);
  return normalized === "openclaw-anthropic-messages-transport" ? "anthropic-messages" : normalized;
}

function hasConcreteResponseModel(ref: ReplayModelRef): boolean {
  const responseModelId = normalizeModelId(ref.responseModelId);
  // Deployment APIs may echo the requested alias. Only a different response
  // model proves the backing identity and overrides configured metadata.
  return responseModelId.length > 0 && responseModelId !== normalizeModelId(ref.modelId);
}

export function usesClaudeFable5MessagesContract(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  return (
    normalizeApi(model.api) === "anthropic-messages" &&
    resolveClaudeFable5ModelIdentity(model) !== undefined
  );
}

export function requiresClaudeAdaptiveThinking(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  if (normalizeApi(model.api) !== "anthropic-messages") {
    return false;
  }
  const modelId = resolveClaudeModelIdentity(model);
  return (
    resolveClaudeFable5ModelIdentity(model) !== undefined ||
    /(?:^|-)claude-mythos-preview(?=$|[^a-z0-9])/.test(modelId)
  );
}

function resolveReplayFableIdentity(ref: ReplayModelRef): string | undefined {
  if (normalizeApi(ref.api) !== "anthropic-messages") {
    return undefined;
  }
  if (hasConcreteResponseModel(ref)) {
    return resolveClaudeFable5ModelIdentity({ id: ref.responseModelId });
  }
  return resolveClaudeFable5ModelIdentity({ id: ref.modelId, params: ref.modelParams });
}

export function resolveModelBoundThinkingReplayMode(params: {
  source: ReplayModelRef;
  target: ReplayModelRef;
}): "default" | "preserve" | "drop" {
  const sourceApi = normalizeApi(params.source.api);
  const targetApi = normalizeApi(params.target.api);
  const sourceIdentity = resolveReplayFableIdentity(params.source);
  const targetIdentity = resolveReplayFableIdentity(params.target);
  const sameRoute =
    normalizeLowercaseStringOrEmpty(params.source.provider) ===
      normalizeLowercaseStringOrEmpty(params.target.provider) &&
    sourceApi === targetApi &&
    normalizeModelId(params.source.modelId) === normalizeModelId(params.target.modelId);
  if (!sourceIdentity && !targetIdentity) {
    return "default";
  }
  if (!sourceIdentity && !hasConcreteResponseModel(params.source) && targetIdentity && sameRoute) {
    return "preserve";
  }
  const sameModel = sourceApi === targetApi && sourceIdentity === targetIdentity;
  return sameModel ? "preserve" : "drop";
}
