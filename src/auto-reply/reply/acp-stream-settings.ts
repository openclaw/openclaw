/** ACP streaming and projection settings derived from config. */
import type { AcpSessionUpdateTag } from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";

const DEFAULT_ACP_STREAM_COALESCE_IDLE_MS = 350;
const DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS = 1800;
const DEFAULT_ACP_REPEAT_SUPPRESSION = true;
const DEFAULT_ACP_DELIVERY_MODE = "final_only";
const DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR = "paragraph";
const DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR_LIVE = "space";
const DEFAULT_ACP_MAX_OUTPUT_CHARS = 24_000;
const DEFAULT_ACP_MAX_SESSION_UPDATE_CHARS = 320;

const ACP_TAG_VISIBILITY_DEFAULTS = {
  agent_message_chunk: true,
  tool_call: false,
  tool_call_update: false,
  usage_update: false,
  available_commands_update: false,
  current_mode_update: false,
  config_option_update: false,
  session_info_update: false,
  plan: false,
  agent_thought_chunk: false,
} satisfies Record<AcpSessionUpdateTag, boolean>;

function isAcpSessionUpdateTag(tag: string): tag is keyof typeof ACP_TAG_VISIBILITY_DEFAULTS {
  return Object.hasOwn(ACP_TAG_VISIBILITY_DEFAULTS, tag);
}

/** ACP delivery strategy for projected assistant output. */
type AcpDeliveryMode = "live" | "final_only";

/** Normalized ACP projection settings consumed by stream projectors. */
export type AcpProjectionSettings = {
  deliveryMode: AcpDeliveryMode;
  hiddenBoundarySeparator: "space" | "paragraph";
  repeatSuppression: boolean;
  maxOutputChars: number;
  maxSessionUpdateChars: number;
  tagVisibility: Partial<Record<AcpSessionUpdateTag, boolean>>;
};

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveAcpDeliveryMode(value: unknown): AcpDeliveryMode {
  if (value === "live" || value === "final_only") {
    return value;
  }
  return DEFAULT_ACP_DELIVERY_MODE;
}

/** Resolves ACP projection settings with bounded defaults. */
export function resolveAcpProjectionSettings(cfg: OpenClawConfig): AcpProjectionSettings {
  const stream = cfg.acp?.stream;
  const deliveryMode = resolveAcpDeliveryMode(stream?.deliveryMode);
  return {
    deliveryMode,
    hiddenBoundarySeparator:
      deliveryMode === "live"
        ? DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR_LIVE
        : DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR,
    repeatSuppression: clampBoolean(stream?.repeatSuppression, DEFAULT_ACP_REPEAT_SUPPRESSION),
    maxOutputChars: DEFAULT_ACP_MAX_OUTPUT_CHARS,
    maxSessionUpdateChars: DEFAULT_ACP_MAX_SESSION_UPDATE_CHARS,
    tagVisibility: stream?.tagVisibility ?? {},
  };
}

/** Resolves ACP streaming chunk/coalescing settings. */
export function resolveAcpStreamingConfig(params: {
  cfg: OpenClawConfig;
  provider?: string;
  accountId?: string;
  deliveryMode?: AcpDeliveryMode;
}) {
  const resolved = resolveEffectiveBlockStreamingConfig({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.accountId,
    maxChunkChars: DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS,
    coalesceIdleMs: DEFAULT_ACP_STREAM_COALESCE_IDLE_MS,
  });

  // In live mode, ACP text deltas should flush promptly and never be held
  // behind large generic min-char thresholds.
  if (params.deliveryMode === "live") {
    return {
      chunking: {
        ...resolved.chunking,
        minChars: 1,
      },
      coalescing: {
        ...resolved.coalescing,
        minChars: 1,
        // ACP delta streams already carry spacing/newlines; preserve exact text.
        joiner: "",
      },
    };
  }

  return resolved;
}

export function isAcpTagVisible(settings: AcpProjectionSettings, tag: string | undefined): boolean {
  if (!tag) {
    return true;
  }
  if (!isAcpSessionUpdateTag(tag)) {
    return true;
  }
  const override = settings.tagVisibility[tag];
  if (typeof override === "boolean") {
    return override;
  }
  return ACP_TAG_VISIBILITY_DEFAULTS[tag];
}
