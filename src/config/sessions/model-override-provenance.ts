// Model override provenance detects fallback-generated selections that resets should drop.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "./types.js";

/** Detects model overrides created by automatic fallback provenance. */
export function hasSessionAutoModelFallbackProvenance(
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
      >
    | undefined,
): boolean {
  const hasActiveOverride = Boolean(
    normalizeOptionalString(entry?.providerOverride) ||
    normalizeOptionalString(entry?.modelOverride),
  );
  return Boolean(
    hasActiveOverride &&
    normalizeOptionalString(entry?.modelOverrideFallbackOriginProvider) &&
    normalizeOptionalString(entry?.modelOverrideFallbackOriginModel),
  );
}

function modelRefMatchesProviderModel(params: {
  ref?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}): boolean {
  const ref = normalizeOptionalString(params.ref);
  const model = normalizeOptionalString(params.model);
  if (!ref || !model) {
    return false;
  }
  if (ref === model) {
    return true;
  }
  const provider = normalizeOptionalString(params.provider);
  return Boolean(provider && ref === `${provider}/${model}`);
}

function hasFallbackNoticeModelOverrideProvenance(
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelProvider"
        | "fallbackNoticeSelectedModel"
        | "fallbackNoticeActiveModel"
      >
    | undefined,
): boolean {
  const selected = normalizeOptionalString(entry?.fallbackNoticeSelectedModel);
  const active = normalizeOptionalString(entry?.fallbackNoticeActiveModel);
  if (!selected || !active || selected === active) {
    return false;
  }
  return modelRefMatchesProviderModel({
    ref: active,
    provider: entry?.providerOverride ?? entry?.modelProvider,
    model: entry?.modelOverride,
  });
}

/** Detects auto-fallback model overrides persisted before modelOverrideSource was available. */
export function hasSessionRecoveredAutoModelOverrideProvenance(
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelProvider"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
        | "fallbackNoticeSelectedModel"
        | "fallbackNoticeActiveModel"
      >
    | undefined,
): boolean {
  return (
    hasSessionAutoModelFallbackProvenance(entry) || hasFallbackNoticeModelOverrideProvenance(entry)
  );
}
