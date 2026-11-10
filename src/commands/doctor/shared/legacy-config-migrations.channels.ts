import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { visitChannelEntries } from "./legacy-config-record-shared.js";

function hasLegacyThreadBindingSpawnSplit(value: unknown): boolean {
  const threadBindings = getRecord(value);
  return Boolean(
    threadBindings &&
    (Object.hasOwn(threadBindings, "spawnSubagentSessions") ||
      Object.hasOwn(threadBindings, "spawnAcpSessions")),
  );
}

type ThreadBindingMigrationParams = {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
};

function migrateThreadBindingsSpawnSessionsForPath(params: ThreadBindingMigrationParams): void {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasLegacyThreadBindingSpawnSplit(threadBindings)) {
    return;
  }

  const hadSpawnSessions = threadBindings.spawnSessions !== undefined;
  const oldSubagent = threadBindings.spawnSubagentSessions;
  const oldAcp = threadBindings.spawnAcpSessions;
  const legacyFlags = [oldSubagent, oldAcp].filter(
    (flag): flag is boolean => typeof flag === "boolean",
  );
  const resolved = legacyFlags.length > 0 ? legacyFlags.every((flag) => flag) : undefined;
  delete threadBindings.spawnSubagentSessions;
  delete threadBindings.spawnAcpSessions;
  if (!hadSpawnSessions && resolved !== undefined) {
    threadBindings.spawnSessions = resolved;
  }

  if (hadSpawnSessions) {
    params.changes.push(
      `Removed deprecated ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions (${params.pathPrefix}.threadBindings.spawnSessions already set).`,
    );
  } else if (
    typeof oldSubagent === "boolean" &&
    typeof oldAcp === "boolean" &&
    oldSubagent !== oldAcp
  ) {
    params.changes.push(
      `Collapsed conflicting ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions → ${params.pathPrefix}.threadBindings.spawnSessions (${String(resolved)}).`,
    );
  } else {
    params.changes.push(
      `Moved ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions → ${params.pathPrefix}.threadBindings.spawnSessions (${String(resolved)}).`,
    );
  }
}

function hasLegacyThreadBindingInAnyChannel(value: unknown): boolean {
  let matched = false;
  for (const channelId of Object.keys(getRecord(value) ?? {})) {
    visitChannelEntries({ channels: value }, channelId, (owner) => {
      matched ||= hasLegacyThreadBindingSpawnSplit(owner.threadBindings);
    });
    if (matched) {
      return true;
    }
  }
  return false;
}

export const LEGACY_CONFIG_MIGRATIONS_CHANNELS: LegacyConfigMigrationSpec[] = [
  {
    id: "thread-bindings.spawn-sessions",
    legacyRules: [
      {
        path: ["session", "threadBindings"],
        message:
          'session.threadBindings.spawnSubagentSessions/spawnAcpSessions were replaced by session.threadBindings.spawnSessions. Run "openclaw doctor --fix".',
        match: hasLegacyThreadBindingSpawnSplit,
      },
      {
        path: ["channels"],
        message:
          'channels.<id>.threadBindings.spawnSubagentSessions/spawnAcpSessions were replaced by channels.<id>.threadBindings.spawnSessions. Run "openclaw doctor --fix".',
        match: hasLegacyThreadBindingInAnyChannel,
      },
    ],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (session) {
        migrateThreadBindingsSpawnSessionsForPath({
          owner: session,
          pathPrefix: "session",
          changes,
        });
      }

      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      for (const channelId of Object.keys(channels)) {
        visitChannelEntries(raw, channelId, (owner, pathPrefix) => {
          migrateThreadBindingsSpawnSessionsForPath({ owner, pathPrefix, changes });
        });
      }
    },
  },
];
