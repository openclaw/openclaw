import type { OpenClawConfig } from "../../../config/config.js";
import { collectProviderDangerousNameMatchingScopes } from "../../../config/dangerous-name-matching.js";
import {
  isDiscordMutableAllowEntry,
  isGoogleChatMutableAllowEntry,
  isIrcMutableAllowEntry,
  isMSTeamsMutableAllowEntry,
  isMattermostMutableAllowEntry,
  isSlackMutableAllowEntry,
  isZalouserMutableGroupEntry,
} from "../../../security/mutable-allowlist-detectors.js";
import { asObjectRecord } from "./object.js";

export type MutableAllowlistHit = {
  channel: string;
  path: string;
  entry: string;
  dangerousFlagPath: string;
};

function addMutableAllowlistHits(params: {
  hits: MutableAllowlistHit[];
  pathLabel: string;
  list: unknown;
  detector: (entry: string) => boolean;
  channel: string;
  dangerousFlagPath: string;
}) {
  if (!Array.isArray(params.list)) {
    return;
  }
  for (const entry of params.list) {
    const text = String(entry).trim();
    if (!text || text === "*") {
      continue;
    }
    if (!params.detector(text)) {
      continue;
    }
    params.hits.push({
      channel: params.channel,
      path: params.pathLabel,
      entry: text,
      dangerousFlagPath: params.dangerousFlagPath,
    });
  }
}

export function scanMutableAllowlistEntries(cfg: OpenClawConfig): MutableAllowlistHit[] {
  const hits: MutableAllowlistHit[] = [];

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "discord")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isDiscordMutableAllowEntry,
      channel: "discord",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.dm.allowFrom`,
        list: dm.allowFrom,
        detector: isDiscordMutableAllowEntry,
        channel: "discord",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
    const guilds = asObjectRecord(scope.account.guilds);
    if (!guilds) {
      continue;
    }
    for (const [guildId, guildRaw] of Object.entries(guilds)) {
      const guild = asObjectRecord(guildRaw);
      if (!guild) {
        continue;
      }
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.guilds.${guildId}.users`,
        list: guild.users,
        detector: isDiscordMutableAllowEntry,
        channel: "discord",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
      const channels = asObjectRecord(guild.channels);
      if (!channels) {
        continue;
      }
      for (const [channelId, channelRaw] of Object.entries(channels)) {
        const channel = asObjectRecord(channelRaw);
        if (!channel) {
          continue;
        }
        addMutableAllowlistHits({
          hits,
          pathLabel: `${scope.prefix}.guilds.${guildId}.channels.${channelId}.users`,
          list: channel.users,
          detector: isDiscordMutableAllowEntry,
          channel: "discord",
          dangerousFlagPath: scope.dangerousFlagPath,
        });
      }
    }
  }

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "slack")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isSlackMutableAllowEntry,
      channel: "slack",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.dm.allowFrom`,
        list: dm.allowFrom,
        detector: isSlackMutableAllowEntry,
        channel: "slack",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
    const channels = asObjectRecord(scope.account.channels);
    if (!channels) {
      continue;
    }
    for (const [channelKey, channelRaw] of Object.entries(channels)) {
      const channel = asObjectRecord(channelRaw);
      if (!channel) {
        continue;
      }
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.channels.${channelKey}.users`,
        list: channel.users,
        detector: isSlackMutableAllowEntry,
        channel: "slack",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
  }

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "googlechat")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
      detector: isGoogleChatMutableAllowEntry,
      channel: "googlechat",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.dm.allowFrom`,
        list: dm.allowFrom,
        detector: isGoogleChatMutableAllowEntry,
        channel: "googlechat",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
    const groups = asObjectRecord(scope.account.groups);
    if (!groups) {
      continue;
    }
    for (const [groupKey, groupRaw] of Object.entries(groups)) {
      const group = asObjectRecord(groupRaw);
      if (!group) {
        continue;
      }
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.groups.${groupKey}.users`,
        list: group.users,
        detector: isGoogleChatMutableAllowEntry,
        channel: "googlechat",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
  }

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "msteams")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isMSTeamsMutableAllowEntry,
      channel: "msteams",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
      detector: isMSTeamsMutableAllowEntry,
      channel: "msteams",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
  }

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "mattermost")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isMattermostMutableAllowEntry,
      channel: "mattermost",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
      detector: isMattermostMutableAllowEntry,
      channel: "mattermost",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
  }

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "irc")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.allowFrom`,
      list: scope.account.allowFrom,
      detector: isIrcMutableAllowEntry,
      channel: "irc",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    addMutableAllowlistHits({
      hits,
      pathLabel: `${scope.prefix}.groupAllowFrom`,
      list: scope.account.groupAllowFrom,
      detector: isIrcMutableAllowEntry,
      channel: "irc",
      dangerousFlagPath: scope.dangerousFlagPath,
    });
    const groups = asObjectRecord(scope.account.groups);
    if (!groups) {
      continue;
    }
    for (const [groupKey, groupRaw] of Object.entries(groups)) {
      const group = asObjectRecord(groupRaw);
      if (!group) {
        continue;
      }
      addMutableAllowlistHits({
        hits,
        pathLabel: `${scope.prefix}.groups.${groupKey}.allowFrom`,
        list: group.allowFrom,
        detector: isIrcMutableAllowEntry,
        channel: "irc",
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
  }

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "zalouser")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    const groups = asObjectRecord(scope.account.groups);
    if (!groups) {
      continue;
    }
    for (const entry of Object.keys(groups)) {
      if (!isZalouserMutableGroupEntry(entry)) {
        continue;
      }
      hits.push({
        channel: "zalouser",
        path: `${scope.prefix}.groups`,
        entry,
        dangerousFlagPath: scope.dangerousFlagPath,
      });
    }
  }

  return hits;
}
