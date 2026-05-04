import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const RETIRED_QUEUE_MODES = new Set(["steer", "queue", "steer-backlog", "steer+backlog"]);

function isRetiredQueueMode(value: unknown): value is string {
  return typeof value === "string" && RETIRED_QUEUE_MODES.has(value);
}

function hasRetiredQueueModeByChannel(value: unknown): boolean {
  const byChannel = getRecord(value);
  return Boolean(byChannel && Object.values(byChannel).some(isRetiredQueueMode));
}

function migrateQueueMode(params: {
  owner: Record<string, unknown>;
  key: string;
  path: string;
  changes: string[];
}): boolean {
  const value = params.owner[params.key];
  if (!isRetiredQueueMode(value)) {
    return false;
  }
  params.owner[params.key] = "followup";
  params.changes.push(
    `Moved deprecated ${params.path} "${value}" → "followup"; active-run steering is now automatic.`,
  );
  return true;
}

const QUEUE_MODE_RULES: LegacyConfigRule[] = [
  {
    path: ["messages", "queue", "mode"],
    message:
      'messages.queue.mode uses a retired steering mode; use followup, collect, or interrupt. Active-run steering is automatic. Run "openclaw doctor --fix".',
    match: isRetiredQueueMode,
  },
  {
    path: ["messages", "queue", "byChannel"],
    message:
      'messages.queue.byChannel contains a retired steering mode; use followup, collect, or interrupt. Active-run steering is automatic. Run "openclaw doctor --fix".',
    match: hasRetiredQueueModeByChannel,
  },
];

export const LEGACY_CONFIG_MIGRATIONS_QUEUE: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "messages.queue.retired-steering-modes",
    describe: "Move retired messages.queue steering modes to followup fallback mode",
    legacyRules: QUEUE_MODE_RULES,
    apply: (raw, changes) => {
      const queue = getRecord(getRecord(raw.messages)?.queue);
      if (!queue) {
        return;
      }

      migrateQueueMode({
        owner: queue,
        key: "mode",
        path: "messages.queue.mode",
        changes,
      });

      const byChannel = getRecord(queue.byChannel);
      if (byChannel) {
        for (const [channelId, _value] of Object.entries(byChannel)) {
          migrateQueueMode({
            owner: byChannel,
            key: channelId,
            path: `messages.queue.byChannel.${channelId}`,
            changes,
          });
        }
        queue.byChannel = byChannel;
      }
    },
  }),
];
