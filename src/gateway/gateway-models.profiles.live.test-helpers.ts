import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { clampThinkingLevel, type Model, type ModelThinkingLevel } from "../plugin-sdk/llm.js";
import { resolveEffectiveThinkingProfile } from "../plugins/provider-thinking.js";
import type { ProviderDefaultThinkingPolicyContext } from "../plugins/provider-thinking.types.js";

/** Keeps strict provider proofs scoped to their admitted agent and child runs. */
export function isolateLiveGatewayConfig(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      controlUi: {
        ...cfg.gateway?.controlUi,
        // Session-observer digests are independent utility-model traffic and can
        // select the current candidate while a strict wire proof is active.
        sessionObserver: false,
      },
    },
  };
}

const GATEWAY_LIVE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
type GatewayLiveThinkingLevel = (typeof GATEWAY_LIVE_THINKING_LEVELS)[number];

export function resolveGatewayLiveModelThinkingLevel(params: {
  model: Model;
  requestedLevel: string;
}): string {
  const { model, requestedLevel } = params;
  const normalized = requestedLevel.trim().toLowerCase();
  if (!isGatewayLiveThinkingLevel(normalized)) {
    return requestedLevel;
  }
  const profile = resolveEffectiveThinkingProfile({
    provider: model.provider,
    context: {
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      agentRuntime: "openclaw",
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: getProviderThinkingModelCompat(model),
    },
  });
  if (profile) {
    const levelIds = profile.levels.map((level) => level.id);
    if (levelIds.some((level) => level === normalized)) {
      if (normalized === "ultra") {
        return normalized;
      }
      const clamped = clampThinkingLevel(model, normalized as ModelThinkingLevel);
      if (normalized === "max" && clamped !== normalized) {
        throw new Error(
          `${model.provider}/${model.id} advertises max but model metadata clamps it to ${clamped}`,
        );
      }
      return clamped;
    }
    if (normalized === "max" || normalized === "ultra") {
      throw new Error(`${model.provider}/${model.id} does not advertise ${normalized}`);
    }
    if (profile.defaultLevel) {
      return clampThinkingLevel(model, profile.defaultLevel as ModelThinkingLevel);
    }
    if (levelIds.length === 1) {
      const [onlyLevel] = levelIds;
      return onlyLevel
        ? clampThinkingLevel(model, onlyLevel as ModelThinkingLevel)
        : requestedLevel;
    }
  }
  if (normalized === "ultra") {
    throw new Error(`${model.provider}/${model.id} does not advertise ultra`);
  }
  const clamped = clampThinkingLevel(model, normalized as ModelThinkingLevel);
  if (normalized === "max" && clamped !== normalized) {
    throw new Error(`${model.provider}/${model.id} clamps max to ${clamped}`);
  }
  return clamped;
}

function getProviderThinkingModelCompat(
  model: Model,
): ProviderDefaultThinkingPolicyContext["compat"] {
  const record = model.compat;
  if (!isRecord(record)) {
    return undefined;
  }
  const thinkingFormat =
    typeof record.thinkingFormat === "string" ? record.thinkingFormat : undefined;
  const supportsReasoningEffort =
    typeof record.supportsReasoningEffort === "boolean"
      ? record.supportsReasoningEffort
      : undefined;
  const supportedReasoningEfforts =
    Array.isArray(record.supportedReasoningEfforts) &&
    record.supportedReasoningEfforts.every((value) => typeof value === "string")
      ? record.supportedReasoningEfforts
      : record.supportedReasoningEfforts === null
        ? null
        : undefined;
  return thinkingFormat ||
    supportsReasoningEffort !== undefined ||
    supportedReasoningEfforts !== undefined
    ? {
        ...(thinkingFormat ? { thinkingFormat } : {}),
        ...(supportsReasoningEffort !== undefined ? { supportsReasoningEffort } : {}),
        ...(supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts } : {}),
      }
    : undefined;
}

export function resolveGatewayLiveThinkingLevel(params: { raw?: string; smoke: boolean }): string {
  const raw = params.raw?.trim().toLowerCase();
  if (!raw) {
    return params.smoke ? "low" : "high";
  }
  return isGatewayLiveThinkingLevel(raw) ? raw : params.smoke ? "low" : "high";
}

function isGatewayLiveThinkingLevel(value: string): value is GatewayLiveThinkingLevel {
  return GATEWAY_LIVE_THINKING_LEVELS.some((level) => level === value);
}
