/**
 * Normalize Discord ID list fields in a raw config object so every entry is a string.
 * Used when storing resolved config so merge/write does not persist numbers (which
 * lose precision for 64-bit snowflake IDs). See issue #22437.
 */

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

type DiscordIdListRef = { holder: Record<string, unknown>; key: string };

function collectDiscordIdListRefs(account: Record<string, unknown>): DiscordIdListRef[] {
  const refs: DiscordIdListRef[] = [{ holder: account, key: "allowFrom" }];
  const dm = asObjectRecord(account.dm);
  if (dm) {
    refs.push({ holder: dm, key: "allowFrom" });
    refs.push({ holder: dm, key: "groupChannels" });
  }
  const execApprovals = asObjectRecord(account.execApprovals);
  if (execApprovals) {
    refs.push({ holder: execApprovals, key: "approvers" });
  }
  const guilds = asObjectRecord(account.guilds);
  if (!guilds) {
    return refs;
  }
  for (const guildId of Object.keys(guilds)) {
    const guild = asObjectRecord(guilds[guildId]);
    if (!guild) {
      continue;
    }
    refs.push({ holder: guild, key: "users" });
    refs.push({ holder: guild, key: "roles" });
    const channels = asObjectRecord(guild.channels);
    if (!channels) {
      continue;
    }
    for (const channelId of Object.keys(channels)) {
      const channel = asObjectRecord(channels[channelId]);
      if (!channel) {
        continue;
      }
      refs.push({ holder: channel, key: "users" });
      refs.push({ holder: channel, key: "roles" });
    }
  }
  return refs;
}

function normalizeList(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw.map((entry) => (typeof entry === "number" ? String(entry) : entry));
}

/**
 * Returns a deep clone of `resolved` with every Discord ID list (allowFrom, approvers,
 * users, roles, groupChannels) normalized so array entries are strings.
 */
export function normalizeDiscordIdListsInResolved(resolved: unknown): unknown {
  const root = resolved as Record<string, unknown> | null | undefined;
  const discord = asObjectRecord(
    root?.channels && (root.channels as Record<string, unknown>).discord,
  );
  if (!discord) {
    return resolved;
  }

  const out = structuredClone(resolved) as Record<string, unknown>;
  const outChannels = asObjectRecord(out.channels);
  if (!outChannels) {
    return out;
  }
  const outDiscord = asObjectRecord(outChannels.discord);
  if (!outDiscord) {
    return out;
  }

  const scopes: Array<Record<string, unknown>> = [outDiscord];
  const accounts = asObjectRecord(outDiscord.accounts);
  if (accounts) {
    for (const key of Object.keys(accounts)) {
      const account = asObjectRecord(accounts[key]);
      if (account) {
        scopes.push(account);
      }
    }
  }

  for (const account of scopes) {
    for (const ref of collectDiscordIdListRefs(account)) {
      const normalized = normalizeList(ref.holder[ref.key]);
      if (normalized !== null) {
        ref.holder[ref.key] = normalized;
      }
    }
  }
  return out;
}
