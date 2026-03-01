import type { AcpSessionUpdateTag } from "../../acp/runtime/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";

const DEFAULT_ACP_STREAM_COALESCE_IDLE_MS = 350;
const DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS = 1800;
const DEFAULT_ACP_REPEAT_SUPPRESSION = true;
const DEFAULT_ACP_DELIVERY_MODE = "final_only";
const DEFAULT_ACP_MAX_TURN_CHARS = 24_000;
const DEFAULT_ACP_MAX_TOOL_SUMMARY_CHARS = 320;
const DEFAULT_ACP_MAX_STATUS_CHARS = 320;
const DEFAULT_ACP_MAX_META_EVENTS_PER_TURN = 64;

export const ACP_TAG_VISIBILITY_DEFAULTS: Record<AcpSessionUpdateTag, boolean> = {
  agent_message_chunk: true,
  tool_call: true,
  tool_call_update: true,
  usage_update: false,
  available_commands_update: false,
  current_mode_update: false,
  config_option_update: false,
  session_info_update: false,
  plan: false,
  agent_thought_chunk: false,
};

export type AcpDeliveryMode = "live" | "final_only";

export type AcpProjectionSettings = {
  deliveryMode: AcpDeliveryMode;
  repeatSuppression: boolean;
  maxTurnChars: number;
  maxToolSummaryChars: number;
  maxStatusChars: number;
  maxMetaEventsPerTurn: number;
  tagVisibility: Partial<Record<AcpSessionUpdateTag, boolean>>;
};

function clampPositiveInteger(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded < bounds.min) {
    return bounds.min;
  }
  if (rounded > bounds.max) {
    return bounds.max;
  }
  return rounded;
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveAcpDeliveryMode(value: unknown): AcpDeliveryMode {
  if (value === "live" || value === "final_only") {
    return value;
  }
  return DEFAULT_ACP_DELIVERY_MODE;
}

function resolveAcpStreamCoalesceIdleMs(cfg: OpenClawConfig): number {
  return clampPositiveInteger(
    cfg.acp?.stream?.coalesceIdleMs,
    DEFAULT_ACP_STREAM_COALESCE_IDLE_MS,
    {
      min: 0,
      max: 5_000,
    },
  );
}

function resolveAcpStreamMaxChunkChars(cfg: OpenClawConfig): number {
  return clampPositiveInteger(cfg.acp?.stream?.maxChunkChars, DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS, {
    min: 50,
    max: 4_000,
  });
}

export function resolveAcpProjectionSettings(cfg: OpenClawConfig): AcpProjectionSettings {
  const stream = cfg.acp?.stream;
  return {
    deliveryMode: resolveAcpDeliveryMode(stream?.deliveryMode),
    repeatSuppression: clampBoolean(stream?.repeatSuppression, DEFAULT_ACP_REPEAT_SUPPRESSION),
    maxTurnChars: clampPositiveInteger(stream?.maxTurnChars, DEFAULT_ACP_MAX_TURN_CHARS, {
      min: 1,
      max: 500_000,
    }),
    maxToolSummaryChars: clampPositiveInteger(
      stream?.maxToolSummaryChars,
      DEFAULT_ACP_MAX_TOOL_SUMMARY_CHARS,
      {
        min: 64,
        max: 8_000,
      },
    ),
    maxStatusChars: clampPositiveInteger(stream?.maxStatusChars, DEFAULT_ACP_MAX_STATUS_CHARS, {
      min: 64,
      max: 8_000,
    }),
    maxMetaEventsPerTurn: clampPositiveInteger(
      stream?.maxMetaEventsPerTurn,
      DEFAULT_ACP_MAX_META_EVENTS_PER_TURN,
      {
        min: 1,
        max: 2_000,
      },
    ),
    tagVisibility: stream?.tagVisibility ?? {},
  };
}

export function resolveAcpStreamingConfig(params: {
  cfg: OpenClawConfig;
  provider?: string;
  accountId?: string;
}) {
  return resolveEffectiveBlockStreamingConfig({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.accountId,
    maxChunkChars: resolveAcpStreamMaxChunkChars(params.cfg),
    coalesceIdleMs: resolveAcpStreamCoalesceIdleMs(params.cfg),
  });
}

export function isAcpTagVisible(
  settings: AcpProjectionSettings,
  tag: AcpSessionUpdateTag | undefined,
): boolean {
  if (!tag) {
    return true;
  }
  const override = settings.tagVisibility[tag];
  if (typeof override === "boolean") {
    return override;
  }
  if (Object.prototype.hasOwnProperty.call(ACP_TAG_VISIBILITY_DEFAULTS, tag)) {
    return ACP_TAG_VISIBILITY_DEFAULTS[tag];
  }
  return true;
}
