import type { AcpSessionUpdateTag } from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

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

export type AcpProjectionSettings = {
  deliveryMode: "live" | "final_only";
  repeatSuppression: boolean;
  tagVisibility: Partial<Record<AcpSessionUpdateTag, boolean>>;
};

export function resolveAcpProjectionSettings(cfg: OpenClawConfig): AcpProjectionSettings {
  const stream = cfg.acp?.stream;
  return {
    deliveryMode: stream?.deliveryMode === "live" ? "live" : "final_only",
    repeatSuppression: stream?.repeatSuppression !== false,
    tagVisibility: stream?.tagVisibility ?? {},
  };
}

export function isAcpTagVisible(settings: AcpProjectionSettings, tag: string | undefined): boolean {
  if (!tag || !isAcpSessionUpdateTag(tag)) {
    return true;
  }
  const override = settings.tagVisibility[tag];
  if (typeof override === "boolean") {
    return override;
  }
  return ACP_TAG_VISIBILITY_DEFAULTS[tag];
}
