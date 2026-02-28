/**
 * Strips known-invalid runtime keys from a raw config object before Zod validation.
 *
 * The gateway (and older versions) may write keys like `groupAllowFrom`, `allowlist`,
 * or `routing` at config paths where the strict schema does not accept them. If these
 * keys remain in the file, subsequent `loadConfig()` / `readConfigFileSnapshotInternal()`
 * calls reject the config as invalid, causing a crash loop (issue #29780).
 *
 * This module silently strips those keys and returns a list of removed paths so callers
 * can log a warning.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Channel ids whose account schemas do NOT include `groupAllowFrom`.
 * (Discord, Slack — their schemas use `.strict()` and omit `groupAllowFrom`.)
 */
const CHANNELS_WITHOUT_GROUP_ALLOW_FROM = new Set(["discord", "slack"]);

/**
 * Strips known-invalid keys from a raw config object (pre-validation).
 * Returns the mutated config and the list of removed key paths.
 */
export function stripInvalidRuntimeKeys(raw: unknown): {
  config: unknown;
  stripped: string[];
} {
  if (!isRecord(raw)) {
    return { config: raw, stripped: [] };
  }
  const stripped: string[] = [];

  // 1. Strip invalid keys from channel account configs.
  const channels = raw.channels;
  if (isRecord(channels)) {
    for (const [channelId, channelValue] of Object.entries(channels)) {
      if (!isRecord(channelValue)) {
        continue;
      }

      // Strip `allowlist` from all channel top-level configs (never a valid key).
      if (Object.prototype.hasOwnProperty.call(channelValue, "allowlist")) {
        stripped.push(`channels.${channelId}.allowlist`);
        delete channelValue.allowlist;
      }

      // Strip `groupAllowFrom` from channel top-level configs that don't support it.
      if (
        CHANNELS_WITHOUT_GROUP_ALLOW_FROM.has(channelId) &&
        Object.prototype.hasOwnProperty.call(channelValue, "groupAllowFrom")
      ) {
        stripped.push(`channels.${channelId}.groupAllowFrom`);
        delete channelValue.groupAllowFrom;
      }

      const accounts = channelValue.accounts;
      if (!isRecord(accounts)) {
        continue;
      }
      for (const [accountId, accountValue] of Object.entries(accounts)) {
        if (!isRecord(accountValue)) {
          continue;
        }

        // `allowlist` is never a valid account key on any channel.
        if (Object.prototype.hasOwnProperty.call(accountValue, "allowlist")) {
          stripped.push(`channels.${channelId}.accounts.${accountId}.allowlist`);
          delete accountValue.allowlist;
        }

        // `groupAllowFrom` is not valid on Discord / Slack / msteams accounts.
        if (
          CHANNELS_WITHOUT_GROUP_ALLOW_FROM.has(channelId) &&
          Object.prototype.hasOwnProperty.call(accountValue, "groupAllowFrom")
        ) {
          stripped.push(`channels.${channelId}.accounts.${accountId}.groupAllowFrom`);
          delete accountValue.groupAllowFrom;
        }
      }
    }
  }

  // 2. Strip `routing` from agent list entries (never a valid agent entry key).
  const agents = raw.agents;
  if (isRecord(agents) && Array.isArray(agents.list)) {
    for (let i = 0; i < agents.list.length; i++) {
      const entry = agents.list[i];
      if (!isRecord(entry)) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(entry, "routing")) {
        stripped.push(`agents.list.${i}.routing`);
        delete entry.routing;
      }
    }
  }

  return { config: raw, stripped };
}
