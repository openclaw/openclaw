// Legacy model-provider aliases that encoded runtime/backend selection in model refs.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStaticProviderModelId } from "../../../agents/model-ref-shared.js";

type LegacyRuntimeModelProviderAlias = {
  /** Legacy provider id that encoded the runtime in the model ref. */
  legacyProvider: string;
  /** Canonical provider id that should own model selection. */
  provider: string;
  /** Runtime/backend id selected for the migrated ref. */
  runtime: string;
  /** True when the runtime is a CLI backend rather than an embedded harness. */
  cli: boolean;
};

const LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES = [
  {
    legacyProvider: "codex",
    provider: "openai",
    runtime: "codex",
    cli: false,
  },
  {
    legacyProvider: "codex-cli",
    provider: "openai",
    runtime: "codex",
    cli: false,
  },
  {
    legacyProvider: "claude-cli",
    provider: "anthropic",
    runtime: "claude-cli",
    cli: true,
  },
  {
    legacyProvider: "google-gemini-cli",
    provider: "google",
    runtime: "google-gemini-cli",
    cli: true,
  },
] as const satisfies readonly LegacyRuntimeModelProviderAlias[];

function normalizeLegacyRuntimeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === "anthropic-cli" ? "claude-cli" : normalizeProviderId(normalized);
}

const LEGACY_ALIAS_BY_PROVIDER = new Map(
  LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.map((entry) => [
    normalizeLegacyRuntimeProviderId(entry.legacyProvider),
    entry,
  ]),
);

/** Resolve the provider/runtime pair selected by a retired whole-agent CLI runtime. */
export function resolveLegacyCliRuntimeAlias(
  runtimeId: unknown,
): { provider: string; runtime: string } | undefined {
  const runtime = normalizeOptionalLowercaseString(runtimeId);
  if (!runtime || runtime === "auto" || runtime === "openclaw") {
    return undefined;
  }
  const alias = LEGACY_RUNTIME_MODEL_PROVIDER_ALIASES.find(
    (entry) => entry.cli && normalizeProviderId(entry.runtime) === runtime,
  );
  return alias ? { provider: alias.provider, runtime: alias.runtime } : undefined;
}

function resolveLegacyRuntimeModelProviderAlias(
  provider: string,
): LegacyRuntimeModelProviderAlias | undefined {
  return LEGACY_ALIAS_BY_PROVIDER.get(normalizeLegacyRuntimeProviderId(provider));
}

/** Rewrite a legacy runtime-encoded model ref to canonical provider/model plus runtime intent. */
export function migrateLegacyRuntimeModelRef(raw: string): {
  ref: string;
  legacyProvider: string;
  provider: string;
  model: string;
  runtime: string;
  cli: boolean;
} | null {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  const alias = resolveLegacyRuntimeModelProviderAlias(trimmed.slice(0, slash));
  if (!alias) {
    return null;
  }
  const rawModel = trimmed.slice(slash + 1).trim();
  const model = normalizeStaticProviderModelId(alias.provider, rawModel);
  if (!model) {
    return null;
  }
  return {
    ref: `${alias.provider}/${model}`,
    legacyProvider: alias.legacyProvider,
    provider: alias.provider,
    model,
    runtime: alias.runtime,
    cli: alias.cli,
  };
}
