import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

/**
 * Top-level `messages.*` keys that users sometimes misplace under
 * `channels.<id>.messages.*` or `channels.<id>.accounts.<aid>.messages.*`. Those
 * nested paths are not part of any channel schema, so the runtime silently
 * ignores them (see issue #67859 for the Telegram status-reaction variant).
 *
 * This migration moves each known key to its correct location. We do not touch
 * unknown keys so third-party plugin config that happens to nest a `messages`
 * block under a channel entry is preserved as-is.
 */
const MESSAGES_CONFIG_KEYS = [
  "ackReaction",
  "ackReactionScope",
  "removeAckAfterReply",
  "statusReactions",
  "messagePrefix",
  "responsePrefix",
  "groupChat",
  "queue",
  "inbound",
  "suppressToolErrors",
  "tts",
] as const;

type MessagesConfigKey = (typeof MESSAGES_CONFIG_KEYS)[number];

// Keys that have a valid per-channel equivalent. Lifting these out of a misplaced
// `messages` block preserves the user's channel-scoping intent instead of
// unconditionally globalizing them.
const CHANNEL_SCOPED_KEYS = new Set<MessagesConfigKey>(["ackReaction", "responsePrefix"]);

function hasMisplacedMessagesBlock(messagesValue: unknown): boolean {
  const messages = getRecord(messagesValue);
  if (!messages) {
    return false;
  }
  return MESSAGES_CONFIG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(messages, key));
}

function hasMisplacedMessagesInAnyChannel(value: unknown): boolean {
  const channels = getRecord(value);
  if (!channels) {
    return false;
  }
  for (const [channelId, channelValue] of Object.entries(channels)) {
    if (channelId === "defaults" || channelId === "modelByChannel") {
      continue;
    }
    const channel = getRecord(channelValue);
    if (!channel) {
      continue;
    }
    if (hasMisplacedMessagesBlock(channel.messages)) {
      return true;
    }
    const accounts = getRecord(channel.accounts);
    if (!accounts) {
      continue;
    }
    for (const accountValue of Object.values(accounts)) {
      const account = getRecord(accountValue);
      if (!account) {
        continue;
      }
      if (hasMisplacedMessagesBlock(account.messages)) {
        return true;
      }
    }
  }
  return false;
}

function ensureTopLevelMessages(raw: Record<string, unknown>): Record<string, unknown> | null {
  const existing = getRecord(raw.messages);
  if (existing) {
    return existing;
  }
  // Refuse to clobber a non-record value already present under `messages`. The
  // zod schema will reject it anyway; leaving it alone avoids silently erasing
  // user data we do not own.
  if (raw.messages !== undefined) {
    return null;
  }
  const next: Record<string, unknown> = {};
  raw.messages = next;
  return next;
}

function migrateEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  raw: Record<string, unknown>;
  changes: string[];
}): void {
  const messages = getRecord(params.entry.messages);
  if (!messages) {
    return;
  }

  const movedKeys: string[] = [];
  for (const key of MESSAGES_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(messages, key)) {
      continue;
    }
    const value = messages[key];
    const sourcePath = `${params.pathPrefix}.messages.${key}`;

    if (CHANNEL_SCOPED_KEYS.has(key)) {
      // Lift to the channel/account scalar equivalent so the user's
      // channel-scoping intent is preserved.
      const targetPath = `${params.pathPrefix}.${key}`;
      if (params.entry[key] === undefined) {
        params.entry[key] = value;
        params.changes.push(`Moved ${sourcePath} → ${targetPath}.`);
      } else {
        params.changes.push(`Removed ${sourcePath} (${targetPath} already set).`);
      }
    } else {
      // Global-only top-level `messages.*` key. Move to the top-level `messages`
      // object if not already set; otherwise honor the existing top-level value.
      const topLevelMessages = ensureTopLevelMessages(params.raw);
      const targetPath = `messages.${key}`;
      if (topLevelMessages === null) {
        // Top-level `messages` holds a non-record value we will not clobber.
        // Skip the move so the user can resolve the invalid shape manually.
        continue;
      }
      if (topLevelMessages[key] === undefined) {
        topLevelMessages[key] = value;
        params.changes.push(`Moved ${sourcePath} → ${targetPath}.`);
      } else {
        params.changes.push(`Removed ${sourcePath} (${targetPath} already set).`);
      }
    }

    delete messages[key];
    movedKeys.push(key);
  }

  if (movedKeys.length === 0) {
    return;
  }

  // Drop the `messages` container if it is now empty. Preserve any unknown keys
  // the user may have added (third-party plugin config surface) so we never
  // delete data we do not own.
  if (Object.keys(messages).length === 0) {
    delete params.entry.messages;
  } else {
    params.entry.messages = messages;
  }
}

const CHANNEL_MESSAGES_MISPLACEMENT_RULES: LegacyConfigRule[] = [
  {
    path: ["channels"],
    message:
      'channels.<id>.messages.* and channels.<id>.accounts.<aid>.messages.* are not valid config paths. The canonical location is top-level messages.* (per-channel ackReaction/responsePrefix stay on the channel/account). Run "openclaw doctor --fix".',
    match: (value) => hasMisplacedMessagesInAnyChannel(value),
  },
];

export const LEGACY_CONFIG_MIGRATIONS_CHANNEL_MESSAGES: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "channels.<id>.messages->messages",
    describe:
      "Relocate misplaced channels.<id>.messages.* (and account-level nested messages.*) to their canonical locations",
    legacyRules: CHANNEL_MESSAGES_MISPLACEMENT_RULES,
    apply: (raw, changes) => {
      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      for (const [channelId, channelValue] of Object.entries(channels)) {
        if (channelId === "defaults" || channelId === "modelByChannel") {
          continue;
        }
        const channel = getRecord(channelValue);
        if (!channel) {
          continue;
        }

        migrateEntry({
          entry: channel,
          pathPrefix: `channels.${channelId}`,
          raw,
          changes,
        });

        const accounts = getRecord(channel.accounts);
        if (accounts) {
          for (const [accountId, accountValue] of Object.entries(accounts)) {
            const account = getRecord(accountValue);
            if (!account) {
              continue;
            }
            migrateEntry({
              entry: account,
              pathPrefix: `channels.${channelId}.accounts.${accountId}`,
              raw,
              changes,
            });
            accounts[accountId] = account;
          }
          channel.accounts = accounts;
        }

        channels[channelId] = channel;
      }

      raw.channels = channels;
    },
  }),
];
