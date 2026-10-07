import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { ensureOpenDmPolicyAllowFromWildcard } from "../../../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";

export function collectOpenPolicyAllowFromWarnings(params: {
  changes: string[];
  doctorFixCommand: string;
}): string[] {
  if (params.changes.length === 0) {
    return [];
  }
  return [
    ...params.changes.map((line) => sanitizeForLog(line)),
    `- Run "${params.doctorFixCommand}" to add missing allowFrom wildcards.`,
  ];
}

export function maybeRepairOpenPolicyAllowFrom(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const nextChannels = next.channels as Record<string, Record<string, unknown>>;
  for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }

    const capabilities = getDoctorChannelCapabilities(channelName);
    if (capabilities.openDmRequiresAllowFromWildcard === false) {
      continue;
    }
    const mode = capabilities.dmAllowFromMode;
    ensureOpenDmPolicyAllowFromWildcard({
      entry: channelConfig,
      mode,
      pathPrefix: `channels.${channelName}`,
      changes,
    });

    const accounts = asNullableRecord(channelConfig.accounts);
    if (!accounts) {
      continue;
    }
    for (const [accountName, accountConfig] of Object.entries(accounts)) {
      if (accountConfig && typeof accountConfig === "object") {
        ensureOpenDmPolicyAllowFromWildcard({
          entry: accountConfig as Record<string, unknown>,
          mode,
          pathPrefix: `channels.${channelName}.accounts.${accountName}`,
          changes,
        });
      }
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}
