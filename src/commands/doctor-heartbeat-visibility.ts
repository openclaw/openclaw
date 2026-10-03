// Resolves heartbeat visibility toggles across config precedence levels.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const LegacyHeartbeatVisibilitySchema = z
  .object({
    showOk: z.boolean().optional(),
    showAlerts: z.boolean().optional(),
    useIndicator: z.boolean().optional(),
  })
  .strict()
  .optional();

/** Resolved heartbeat presentation toggles after defaults/channel/account precedence. */
export type ResolvedHeartbeatVisibility = {
  /** Whether successful heartbeat content should be sent as visible chat text. */
  showOk: boolean;
  /** Whether warning/error heartbeat content should be sent as visible chat text. */
  showAlerts: boolean;
  /** Whether heartbeat status should emit indicator events for UI surfaces. */
  useIndicator: boolean;
};

const DEFAULT_VISIBILITY: ResolvedHeartbeatVisibility = {
  showOk: false, // Silent by default
  showAlerts: true, // Show content messages
  useIndicator: true, // Emit indicator events
};

/** Resolves heartbeat visibility for a channel, applying account > channel > defaults precedence. */
export function resolveHeartbeatVisibility(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): ResolvedHeartbeatVisibility {
  const { cfg, channel, accountId } = params;

  // Webchat has no channel/account config branch, so only shared channel defaults apply.
  if (channel === "webchat") {
    const channelDefaults = cfg.channels?.defaults?.heartbeatVisibility;
    return {
      showOk: channelDefaults?.showOk ?? DEFAULT_VISIBILITY.showOk,
      showAlerts: channelDefaults?.showAlerts ?? DEFAULT_VISIBILITY.showAlerts,
      useIndicator: channelDefaults?.useIndicator ?? DEFAULT_VISIBILITY.useIndicator,
    };
  }

  // Layer 1: Global channel defaults
  const channelDefaults = cfg.channels?.defaults?.heartbeatVisibility;

  // Layer 2: Per-channel config (at channel root level)
  const channelCfg = asOptionalRecord(cfg.channels?.[channel]);
  const perChannel = LegacyHeartbeatVisibilitySchema.parse(channelCfg?.heartbeatVisibility);

  // Layer 3: Per-account config (most specific)
  const accounts = asOptionalRecord(channelCfg?.accounts);
  const accountCfg = accountId ? asOptionalRecord(accounts?.[accountId]) : undefined;
  const perAccount = LegacyHeartbeatVisibilitySchema.parse(accountCfg?.heartbeatVisibility);

  return {
    showOk:
      perAccount?.showOk ??
      perChannel?.showOk ??
      channelDefaults?.showOk ??
      DEFAULT_VISIBILITY.showOk,
    showAlerts:
      perAccount?.showAlerts ??
      perChannel?.showAlerts ??
      channelDefaults?.showAlerts ??
      DEFAULT_VISIBILITY.showAlerts,
    useIndicator:
      perAccount?.useIndicator ??
      perChannel?.useIndicator ??
      channelDefaults?.useIndicator ??
      DEFAULT_VISIBILITY.useIndicator,
  };
}
