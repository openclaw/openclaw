// Legacy message queue config migrations for retired steering modes.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const RETIRED_QUEUE_MODES = new Set(["queue", "steer-backlog", "steer+backlog"]);

function isRetiredQueueMode(value: unknown): value is string {
  return typeof value === "string" && RETIRED_QUEUE_MODES.has(value);
}

function hasRetiredQueueModeByChannel(value: unknown): boolean {
  const byChannel = getRecord(value);
  return Boolean(byChannel && Object.values(byChannel).some(isRetiredQueueMode));
}

function migrateQueueMode(
  owner: Record<string, unknown>,
  key: string,
  path: string,
  changes: string[],
): void {
  const value = owner[key];
  if (!isRetiredQueueMode(value)) {
    return;
  }
  const replacement = value === "queue" ? "steer" : "followup";
  owner[key] = replacement;
  changes.push(
    `Moved deprecated ${path} "${value}" → "${replacement}"; use "steer" for default active-run steering.`,
  );
}

const QUEUE_MODE_RULES: LegacyConfigRule[] = [
  {
    path: ["messages", "queue", "mode"],
    message:
      'messages.queue.mode uses a retired queue mode; use steer, followup, collect, or interrupt. Run "openclaw doctor --fix".',
    match: isRetiredQueueMode,
  },
  {
    path: ["messages", "queue", "byChannel"],
    message:
      'messages.queue.byChannel contains a retired queue mode; use steer, followup, collect, or interrupt. Run "openclaw doctor --fix".',
    match: hasRetiredQueueModeByChannel,
  },
];

/** Legacy config migration specs for message queue mode compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_QUEUE: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "messages.queue.retired-steering-modes",
    describe: "Move retired messages.queue modes to followup mode",
    legacyRules: QUEUE_MODE_RULES,
    apply: (raw, changes) => {
      const queue = getRecord(getRecord(raw.messages)?.queue);
      if (!queue) {
        return;
      }

      migrateQueueMode(queue, "mode", "messages.queue.mode", changes);

      const byChannel = getRecord(queue.byChannel);
      if (byChannel) {
        for (const channelId of Object.keys(byChannel)) {
          migrateQueueMode(byChannel, channelId, `messages.queue.byChannel.${channelId}`, changes);
        }
      }
    },
  }),
];
