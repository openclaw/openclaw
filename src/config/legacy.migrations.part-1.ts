import {
  formatSlackStreamingBooleanMigrationMessage,
  formatSlackStreamModeMigrationMessage,
  resolveDiscordPreviewStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  resolveTelegramPreviewStreamMode,
} from "./discord-preview-streaming.js";
import { getRecord, type LegacyConfigMigration } from "./legacy.shared.js";

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function escapeControlForLog(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

function migrateThreadBindingsTtlHoursForPath(params: {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasOwnKey(threadBindings, "ttlHours")) {
    return false;
  }

  const hadIdleHours = threadBindings.idleHours !== undefined;
  if (!hadIdleHours) {
    threadBindings.idleHours = threadBindings.ttlHours;
  }
  delete threadBindings.ttlHours;
  params.owner.threadBindings = threadBindings;

  if (hadIdleHours) {
    params.changes.push(
      `Removed ${params.pathPrefix}.threadBindings.ttlHours (${params.pathPrefix}.threadBindings.idleHours already set).`,
    );
  } else {
    params.changes.push(
      `Moved ${params.pathPrefix}.threadBindings.ttlHours → ${params.pathPrefix}.threadBindings.idleHours.`,
    );
  }
  return true;
}

export const LEGACY_CONFIG_MIGRATIONS_PART_1: LegacyConfigMigration[] = [
  {
    id: "thread-bindings.ttlHours->idleHours",
    describe:
      "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channels.discord)",
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (session) {
        migrateThreadBindingsTtlHoursForPath({
          owner: session,
          pathPrefix: "session",
          changes,
        });
        raw.session = session;
      }

      const channels = getRecord(raw.channels);
      const discord = getRecord(channels?.discord);
      if (!channels || !discord) {
        return;
      }

      migrateThreadBindingsTtlHoursForPath({
        owner: discord,
        pathPrefix: "channels.discord",
        changes,
      });

      const accounts = getRecord(discord.accounts);
      if (accounts) {
        for (const [accountId, accountRaw] of Object.entries(accounts)) {
          const account = getRecord(accountRaw);
          if (!account) {
            continue;
          }
          migrateThreadBindingsTtlHoursForPath({
            owner: account,
            pathPrefix: `channels.discord.accounts.${accountId}`,
            changes,
          });
          accounts[accountId] = account;
        }
        discord.accounts = accounts;
      }

      channels.discord = discord;
      raw.channels = channels;
    },
  },
  {
    id: "channels.streaming-keys->channels.streaming",
    describe:
      "Normalize legacy streaming keys to channels.<provider>.streaming (Telegram/Discord/Slack)",
    apply: (raw, changes) => {
      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      const migrateProviderEntry = (params: {
        provider: "telegram" | "discord" | "slack";
        entry: Record<string, unknown>;
        pathPrefix: string;
      }) => {
        const migrateCommonStreamingMode = (
          resolveMode: (entry: Record<string, unknown>) => string,
        ) => {
          const hasLegacyStreamMode = params.entry.streamMode !== undefined;
          const legacyStreaming = params.entry.streaming;
          if (!hasLegacyStreamMode && typeof legacyStreaming !== "boolean") {
            return false;
          }
          const resolved = resolveMode(params.entry);
          params.entry.streaming = resolved;
          if (hasLegacyStreamMode) {
            delete params.entry.streamMode;
            changes.push(
              `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`,
            );
          }
          if (typeof legacyStreaming === "boolean") {
            changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
          }
          return true;
        };

        const hasLegacyStreamMode = params.entry.streamMode !== undefined;
        const legacyStreaming = params.entry.streaming;
        const legacyNativeStreaming = params.entry.nativeStreaming;

        if (params.provider === "telegram") {
          migrateCommonStreamingMode(resolveTelegramPreviewStreamMode);
          return;
        }

        if (params.provider === "discord") {
          migrateCommonStreamingMode(resolveDiscordPreviewStreamMode);
          return;
        }

        if (!hasLegacyStreamMode && typeof legacyStreaming !== "boolean") {
          return;
        }
        const resolvedStreaming = resolveSlackStreamingMode(params.entry);
        const resolvedNativeStreaming = resolveSlackNativeStreaming(params.entry);
        params.entry.streaming = resolvedStreaming;
        params.entry.nativeStreaming = resolvedNativeStreaming;
        if (hasLegacyStreamMode) {
          delete params.entry.streamMode;
          changes.push(formatSlackStreamModeMigrationMessage(params.pathPrefix, resolvedStreaming));
        }
        if (typeof legacyStreaming === "boolean") {
          changes.push(
            formatSlackStreamingBooleanMigrationMessage(params.pathPrefix, resolvedNativeStreaming),
          );
        } else if (typeof legacyNativeStreaming !== "boolean" && hasLegacyStreamMode) {
          changes.push(`Set ${params.pathPrefix}.nativeStreaming → ${resolvedNativeStreaming}.`);
        }
      };

      const migrateProvider = (provider: "telegram" | "discord" | "slack") => {
        const providerEntry = getRecord(channels[provider]);
        if (!providerEntry) {
          return;
        }
        migrateProviderEntry({
          provider,
          entry: providerEntry,
          pathPrefix: `channels.${provider}`,
        });
        const accounts = getRecord(providerEntry.accounts);
        if (!accounts) {
          return;
        }
        for (const [accountId, accountValue] of Object.entries(accounts)) {
          const account = getRecord(accountValue);
          if (!account) {
            continue;
          }
          migrateProviderEntry({
            provider,
            entry: account,
            pathPrefix: `channels.${provider}.accounts.${accountId}`,
          });
        }
      };

      migrateProvider("telegram");
      migrateProvider("discord");
      migrateProvider("slack");
    },
  },
  {
    id: "gateway.bind.host-alias->bind-mode",
    describe: "Normalize gateway.bind host aliases to supported bind modes",
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) {
        return;
      }
      const bindRaw = gateway.bind;
      if (typeof bindRaw !== "string") {
        return;
      }

      const normalized = bindRaw.trim().toLowerCase();
      let mapped: "lan" | "loopback" | undefined;
      if (
        normalized === "0.0.0.0" ||
        normalized === "::" ||
        normalized === "[::]" ||
        normalized === "*"
      ) {
        mapped = "lan";
      } else if (
        normalized === "127.0.0.1" ||
        normalized === "localhost" ||
        normalized === "::1" ||
        normalized === "[::1]"
      ) {
        mapped = "loopback";
      }

      if (!mapped || normalized === mapped) {
        return;
      }

      gateway.bind = mapped;
      raw.gateway = gateway;
      changes.push(`Normalized gateway.bind "${escapeControlForLog(bindRaw)}" → "${mapped}".`);
    },
  },
];
