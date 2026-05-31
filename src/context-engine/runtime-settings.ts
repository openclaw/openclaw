import type { ContextEngineHostSupport } from "./host-compat.js";
import {
  ContextEngineRuntimeSettingsUnavailableError,
  ContextEngineRuntimeSettingsUnsupportedError,
  type ContextEngineRuntimeMode,
  type ContextEngineRuntimeSettings,
} from "./types.js";

type OptionalString = string | null | undefined;

function normalizeNullableString(value: OptionalString): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeNullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildContextEngineRuntimeSettings(params: {
  mode?: ContextEngineRuntimeMode;
  harnessId?: OptionalString;
  runtimeId?: OptionalString;
  requestedModel?: OptionalString;
  resolvedModel?: OptionalString;
  provider?: OptionalString;
  modelFamily?: OptionalString;
  fallbackActive?: boolean;
  fallbackReason?: OptionalString;
  degradedReason?: OptionalString;
  tokenBudget?: number | null;
  maxOutputTokens?: number | null;
  contextEngineHost: ContextEngineHostSupport;
}): ContextEngineRuntimeSettings {
  const hostId = normalizeNullableString(params.contextEngineHost.id);
  if (!hostId) {
    throw new ContextEngineRuntimeSettingsUnavailableError(
      "Context-engine runtime settings require a host id.",
    );
  }
  if (!Array.isArray(params.contextEngineHost.capabilities)) {
    throw new ContextEngineRuntimeSettingsUnsupportedError(
      "Context-engine runtime settings require host capabilities.",
    );
  }

  const fallbackReason = normalizeNullableString(params.fallbackReason);
  const degradedReason = normalizeNullableString(params.degradedReason);
  const fallbackActive = params.fallbackActive ?? Boolean(fallbackReason);
  const mode =
    params.mode ?? (degradedReason ? "degraded" : fallbackActive ? "fallback" : "normal");

  return {
    schemaVersion: 1,
    runtime: {
      host: "openclaw",
      mode,
      harnessId: normalizeNullableString(params.harnessId),
      runtimeId: normalizeNullableString(params.runtimeId),
    },
    model: {
      requested: normalizeNullableString(params.requestedModel),
      resolved: normalizeNullableString(params.resolvedModel),
      provider: normalizeNullableString(params.provider),
      family: normalizeNullableString(params.modelFamily),
      fallbackActive,
    },
    contextEngine: {
      hostId,
      hostLabel: normalizeNullableString(params.contextEngineHost.label),
      capabilities: [...params.contextEngineHost.capabilities],
    },
    limits: {
      tokenBudget: normalizeNullableNumber(params.tokenBudget),
      maxOutputTokens: normalizeNullableNumber(params.maxOutputTokens),
    },
    diagnostics: {
      fallbackReason,
      degradedReason,
    },
  };
}
