// Model reference formatting helpers for auto-reply runtime status.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";

/** Format a provider/model pair without duplicating provider prefixes already in the model id. */
export function formatProviderModelRef(providerRaw: string, modelRaw: string): string {
  const provider = normalizeOptionalString(providerRaw) ?? "";
  const model = normalizeOptionalString(modelRaw) ?? "";
  if (!provider) {
    return model;
  }
  if (!model) {
    return provider;
  }
  const providerLower = normalizeLowercaseStringOrEmpty(provider);
  const modelLower = normalizeLowercaseStringOrEmpty(model);
  const providerPrefix = `${providerLower}/`;
  // If the model id already embeds the same provider prefix (e.g. "openai/gpt-5.4"
  // passed as the model with provider "openai"), strip the redundant prefix so
  // the result stays "openai/gpt-5.4" instead of "openai/openai/gpt-5.4".
  if (modelLower.startsWith(providerPrefix)) {
    const normalizedModel = model.slice(providerPrefix.length).trim();
    if (normalizedModel) {
      return `${provider}/${normalizedModel}`;
    }
  }
  // If the model id embeds a *different* provider prefix (e.g. "openai/gpt-5.4"
  // passed as the model with provider "minimax"), strip the foreign prefix too
  // so the result is "minimax/gpt-5.4" instead of the malformed
  // "minimax/openai/gpt-5.4". Without this, fallback-banner rendering and
  // status messages can leak stale provider/model state from a previous
  // fallback attempt into the active ref.
  const slashIndex = model.indexOf("/");
  if (slashIndex > 0) {
    const embeddedProvider = model.slice(0, slashIndex).trim();
    if (embeddedProvider && normalizeLowercaseStringOrEmpty(embeddedProvider) !== providerLower) {
      const remainder = model.slice(slashIndex + 1).trim();
      if (remainder) {
        return `${provider}/${remainder}`;
      }
    }
  }
  return `${provider}/${model}`;
}

type ModelRef = {
  provider: string;
  model: string;
  label: string;
};

function normalizeModelWithinProvider(provider: string, modelRaw: string): string {
  const model = normalizeOptionalString(modelRaw) ?? "";
  if (!provider || !model) {
    return model;
  }
  const prefix = `${provider}/`;
  if (normalizeLowercaseStringOrEmpty(model).startsWith(normalizeLowercaseStringOrEmpty(prefix))) {
    const withoutPrefix = model.slice(prefix.length).trim();
    if (withoutPrefix) {
      return withoutPrefix;
    }
  }
  return model;
}

function normalizeModelRef(
  rawModel: string,
  fallbackProvider: string,
  parseEmbeddedProvider = false,
): ModelRef {
  const trimmed = normalizeOptionalString(rawModel) ?? "";
  const slashIndex = parseEmbeddedProvider ? trimmed.indexOf("/") : -1;
  if (slashIndex > 0) {
    const provider = normalizeOptionalString(trimmed.slice(0, slashIndex)) ?? "";
    const model = normalizeOptionalString(trimmed.slice(slashIndex + 1)) ?? "";
    if (provider && model) {
      return {
        provider,
        model,
        label: `${provider}/${model}`,
      };
    }
  }
  const provider = normalizeOptionalString(fallbackProvider) ?? "";
  const dedupedModel = normalizeModelWithinProvider(provider, trimmed);
  return {
    provider,
    model: dedupedModel || trimmed,
    label: provider ? formatProviderModelRef(provider, dedupedModel || trimmed) : trimmed,
  };
}

/** Compare configured selected model with the active model stored on a session. */
export function resolveSelectedAndActiveModel(params: {
  selectedProvider: string;
  selectedModel: string;
  sessionEntry?: Pick<SessionEntry, "modelProvider" | "model">;
  parseSelectedProvider?: boolean;
}): {
  selected: ModelRef;
  active: ModelRef;
  activeDiffers: boolean;
} {
  const selected = normalizeModelRef(
    params.selectedModel,
    params.selectedProvider,
    params.parseSelectedProvider,
  );
  const runtimeModel = normalizeOptionalString(params.sessionEntry?.model);
  const runtimeProvider = normalizeOptionalString(params.sessionEntry?.modelProvider);

  const active = runtimeModel
    ? normalizeModelRef(runtimeModel, runtimeProvider || selected.provider, !runtimeProvider)
    : selected;
  const activeDiffers = active.provider !== selected.provider || active.model !== selected.model;

  return {
    selected,
    active,
    activeDiffers,
  };
}
