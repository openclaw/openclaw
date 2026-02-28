import { shouldMoveSingleAccountChannelKey } from "../channels/plugins/setup-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveDiscordPreviewStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  resolveTelegramPreviewStreamMode,
} from "../config/discord-preview-streaming.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export function normalizeCompatibilityConfigValues(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next: OpenClawConfig = cfg;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const normalizeDmAliases = (params: {
    provider: "slack" | "discord";
    entry: Record<string, unknown>;
    pathPrefix: string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    let changed = false;
    let updated: Record<string, unknown> = params.entry;
    const rawDm = updated.dm;
    const dm = isRecord(rawDm) ? structuredClone(rawDm) : null;
    let dmChanged = false;

    const allowFromEqual = (a: unknown, b: unknown): boolean => {
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return false;
      }
      const na = a.map((v) => String(v).trim()).filter(Boolean);
      const nb = b.map((v) => String(v).trim()).filter(Boolean);
      if (na.length !== nb.length) {
        return false;
      }
      return na.every((v, i) => v === nb[i]);
    };

    const topDmPolicy = updated.dmPolicy;
    const legacyDmPolicy = dm?.policy;
    if (topDmPolicy === undefined && legacyDmPolicy !== undefined) {
      updated = { ...updated, dmPolicy: legacyDmPolicy };
      changed = true;
      if (dm) {
        delete dm.policy;
        dmChanged = true;
      }
      changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
    } else if (topDmPolicy !== undefined && legacyDmPolicy !== undefined) {
      if (topDmPolicy === legacyDmPolicy) {
        if (dm) {
          delete dm.policy;
          dmChanged = true;
          changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
        }
      }
    }

    const topAllowFrom = updated.allowFrom;
    const legacyAllowFrom = dm?.allowFrom;
    if (topAllowFrom === undefined && legacyAllowFrom !== undefined) {
      updated = { ...updated, allowFrom: legacyAllowFrom };
      changed = true;
      if (dm) {
        delete dm.allowFrom;
        dmChanged = true;
      }
      changes.push(`Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`);
    } else if (topAllowFrom !== undefined && legacyAllowFrom !== undefined) {
      if (allowFromEqual(topAllowFrom, legacyAllowFrom)) {
        if (dm) {
          delete dm.allowFrom;
          dmChanged = true;
          changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
        }
      }
    }

    if (dm && isRecord(rawDm) && dmChanged) {
      const keys = Object.keys(dm);
      if (keys.length === 0) {
        if (updated.dm !== undefined) {
          const { dm: _ignored, ...rest } = updated;
          updated = rest;
          changed = true;
          changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
        }
      } else {
        updated = { ...updated, dm };
        changed = true;
      }
    }

    return { entry: updated, changed };
  };

  const normalizePreviewStreamingAliases = (params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    resolveStreaming: (entry: Record<string, unknown>) => string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    let updated = params.entry;
    const hadLegacyStreamMode = updated.streamMode !== undefined;
    const beforeStreaming = updated.streaming;
    const resolved = params.resolveStreaming(updated);
    const shouldNormalize =
      hadLegacyStreamMode ||
      typeof beforeStreaming === "boolean" ||
      (typeof beforeStreaming === "string" && beforeStreaming !== resolved);
    if (!shouldNormalize) {
      return { entry: updated, changed: false };
    }

    let changed = false;
    if (beforeStreaming !== resolved) {
      updated = { ...updated, streaming: resolved };
      changed = true;
    }
    if (hadLegacyStreamMode) {
      const { streamMode: _ignored, ...rest } = updated;
      updated = rest;
      changed = true;
      changes.push(
        `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`,
      );
    }
    if (typeof beforeStreaming === "boolean") {
      changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
    } else if (typeof beforeStreaming === "string" && beforeStreaming !== resolved) {
      changes.push(
        `Normalized ${params.pathPrefix}.streaming (${beforeStreaming}) → (${resolved}).`,
      );
    }

    return { entry: updated, changed };
  };

  const normalizeSlackStreamingAliases = (params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    let updated = params.entry;
    const hadLegacyStreamMode = updated.streamMode !== undefined;
    const legacyStreaming = updated.streaming;
    const beforeStreaming = updated.streaming;
    const beforeNativeStreaming = updated.nativeStreaming;
    const resolvedStreaming = resolveSlackStreamingMode(updated);
    const resolvedNativeStreaming = resolveSlackNativeStreaming(updated);
    const shouldNormalize =
      hadLegacyStreamMode ||
      typeof legacyStreaming === "boolean" ||
      (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming);
    if (!shouldNormalize) {
      return { entry: updated, changed: false };
    }

    let changed = false;
    if (beforeStreaming !== resolvedStreaming) {
      updated = { ...updated, streaming: resolvedStreaming };
      changed = true;
    }
    if (
      typeof beforeNativeStreaming !== "boolean" ||
      beforeNativeStreaming !== resolvedNativeStreaming
    ) {
      updated = { ...updated, nativeStreaming: resolvedNativeStreaming };
      changed = true;
    }
    if (hadLegacyStreamMode) {
      const { streamMode: _ignored, ...rest } = updated;
      updated = rest;
      changed = true;
      changes.push(
        `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolvedStreaming}).`,
      );
    }
    if (typeof legacyStreaming === "boolean") {
      changes.push(
        `Moved ${params.pathPrefix}.streaming (boolean) → ${params.pathPrefix}.nativeStreaming (${resolvedNativeStreaming}).`,
      );
    } else if (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming) {
      changes.push(
        `Normalized ${params.pathPrefix}.streaming (${legacyStreaming}) → (${resolvedStreaming}).`,
      );
    }

    return { entry: updated, changed };
  };

  const normalizeStreamingAliasesForProvider = (params: {
    provider: "telegram" | "slack" | "discord";
    entry: Record<string, unknown>;
    pathPrefix: string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    if (params.provider === "telegram") {
      return normalizePreviewStreamingAliases({
        entry: params.entry,
        pathPrefix: params.pathPrefix,
        resolveStreaming: resolveTelegramPreviewStreamMode,
      });
    }
    if (params.provider === "discord") {
      return normalizePreviewStreamingAliases({
        entry: params.entry,
        pathPrefix: params.pathPrefix,
        resolveStreaming: resolveDiscordPreviewStreamMode,
      });
    }
    return normalizeSlackStreamingAliases({
      entry: params.entry,
      pathPrefix: params.pathPrefix,
    });
  };

  const normalizeProvider = (provider: "telegram" | "slack" | "discord") => {
    const channels = next.channels as Record<string, unknown> | undefined;
    const rawEntry = channels?.[provider];
    if (!isRecord(rawEntry)) {
      return;
    }

    let updated = rawEntry;
    let changed = false;
    if (provider !== "telegram") {
      const base = normalizeDmAliases({
        provider,
        entry: rawEntry,
        pathPrefix: `channels.${provider}`,
      });
      updated = base.entry;
      changed = base.changed;
    }
    const providerStreaming = normalizeStreamingAliasesForProvider({
      provider,
      entry: updated,
      pathPrefix: `channels.${provider}`,
    });
    updated = providerStreaming.entry;
    changed = changed || providerStreaming.changed;

    const rawAccounts = updated.accounts;
    if (isRecord(rawAccounts)) {
      let accountsChanged = false;
      const accounts = { ...rawAccounts };
      for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
        if (!isRecord(rawAccount)) {
          continue;
        }
        let accountEntry = rawAccount;
        let accountChanged = false;
        if (provider !== "telegram") {
          const res = normalizeDmAliases({
            provider,
            entry: rawAccount,
            pathPrefix: `channels.${provider}.accounts.${accountId}`,
          });
          accountEntry = res.entry;
          accountChanged = res.changed;
        }
        const accountStreaming = normalizeStreamingAliasesForProvider({
          provider,
          entry: accountEntry,
          pathPrefix: `channels.${provider}.accounts.${accountId}`,
        });
        accountEntry = accountStreaming.entry;
        accountChanged = accountChanged || accountStreaming.changed;
        if (accountChanged) {
          accounts[accountId] = accountEntry;
          accountsChanged = true;
        }
      }
      if (accountsChanged) {
        updated = { ...updated, accounts };
        changed = true;
      }
    }

    if (changed) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          [provider]: updated as unknown,
        },
      };
    }
  };

  const seedMissingDefaultAccountsFromSingleAccountBase = () => {
    const channels = next.channels as Record<string, unknown> | undefined;
    if (!channels) {
      return;
    }

    let channelsChanged = false;
    const nextChannels = { ...channels };
    for (const [channelId, rawChannel] of Object.entries(channels)) {
      if (!isRecord(rawChannel)) {
        continue;
      }
      const rawAccounts = rawChannel.accounts;
      if (!isRecord(rawAccounts)) {
        continue;
      }
      const accountKeys = Object.keys(rawAccounts);
      if (accountKeys.length === 0) {
        continue;
      }
      const hasDefault = accountKeys.some((key) => key.trim().toLowerCase() === DEFAULT_ACCOUNT_ID);
      if (hasDefault) {
        continue;
      }

      const keysToMove = Object.entries(rawChannel)
        .filter(
          ([key, value]) =>
            key !== "accounts" &&
            key !== "enabled" &&
            value !== undefined &&
            shouldMoveSingleAccountChannelKey({ channelKey: channelId, key }),
        )
        .map(([key]) => key);
      if (keysToMove.length === 0) {
        continue;
      }

      const defaultAccount: Record<string, unknown> = {};
      for (const key of keysToMove) {
        const value = rawChannel[key];
        defaultAccount[key] = value && typeof value === "object" ? structuredClone(value) : value;
      }
      const nextChannel: Record<string, unknown> = {
        ...rawChannel,
      };
      for (const key of keysToMove) {
        delete nextChannel[key];
      }
      nextChannel.accounts = {
        ...rawAccounts,
        [DEFAULT_ACCOUNT_ID]: defaultAccount,
      };

      nextChannels[channelId] = nextChannel;
      channelsChanged = true;
      changes.push(
        `Moved channels.${channelId} single-account top-level values into channels.${channelId}.accounts.default.`,
      );
    }

    if (!channelsChanged) {
      return;
    }
    next = {
      ...next,
      channels: nextChannels as OpenClawConfig["channels"],
    };
  };

  normalizeProvider("telegram");
  normalizeProvider("slack");
  normalizeProvider("discord");
  seedMissingDefaultAccountsFromSingleAccountBase();

  const normalizeBrowserSsrFPolicyAlias = () => {
    const rawBrowser = next.browser;
    if (!isRecord(rawBrowser)) {
      return;
    }
    const rawSsrFPolicy = rawBrowser.ssrfPolicy;
    if (!isRecord(rawSsrFPolicy) || !("allowPrivateNetwork" in rawSsrFPolicy)) {
      return;
    }

    const legacyAllowPrivateNetwork = rawSsrFPolicy.allowPrivateNetwork;
    const currentDangerousAllowPrivateNetwork = rawSsrFPolicy.dangerouslyAllowPrivateNetwork;

    let resolvedDangerousAllowPrivateNetwork: unknown = currentDangerousAllowPrivateNetwork;
    if (
      typeof legacyAllowPrivateNetwork === "boolean" ||
      typeof currentDangerousAllowPrivateNetwork === "boolean"
    ) {
      // Preserve runtime behavior while collapsing to the canonical key.
      resolvedDangerousAllowPrivateNetwork =
        legacyAllowPrivateNetwork === true || currentDangerousAllowPrivateNetwork === true;
    } else if (currentDangerousAllowPrivateNetwork === undefined) {
      resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
    }

    const nextSsrFPolicy: Record<string, unknown> = { ...rawSsrFPolicy };
    delete nextSsrFPolicy.allowPrivateNetwork;
    if (resolvedDangerousAllowPrivateNetwork !== undefined) {
      nextSsrFPolicy.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
    }

    const migratedBrowser = { ...next.browser } as Record<string, unknown>;
    migratedBrowser.ssrfPolicy = nextSsrFPolicy;

    next = {
      ...next,
      browser: migratedBrowser as OpenClawConfig["browser"],
    };
    changes.push(
      `Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`,
    );
  };

  normalizeBrowserSsrFPolicyAlias();

  const legacyAckReaction = cfg.messages?.ackReaction?.trim();
  const hasWhatsAppConfig = cfg.channels?.whatsapp !== undefined;
  if (legacyAckReaction && hasWhatsAppConfig) {
    const hasWhatsAppAck = cfg.channels?.whatsapp?.ackReaction !== undefined;
    if (!hasWhatsAppAck) {
      const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      let direct = true;
      let group: "always" | "mentions" | "never" = "mentions";
      if (legacyScope === "all") {
        direct = true;
        group = "always";
      } else if (legacyScope === "direct") {
        direct = true;
        group = "never";
      } else if (legacyScope === "group-all") {
        direct = false;
        group = "always";
      } else if (legacyScope === "group-mentions") {
        direct = false;
        group = "mentions";
      }
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            ackReaction: { emoji: legacyAckReaction, direct, group },
          },
        },
      };
      changes.push(
        `Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`,
      );
    }
  }

  return { config: next, changes };
}
