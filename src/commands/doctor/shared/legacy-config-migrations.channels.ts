// Legacy channel config migration for thread session spawning.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { hasOwnKey, visitChannelEntries } from "./legacy-config-record-shared.js";

function hasLegacyThreadBindingSpawnSplit(value: unknown): boolean {
  const threadBindings = getRecord(value);
  return Boolean(
    threadBindings &&
    (hasOwnKey(threadBindings, "spawnSubagentSessions") ||
      hasOwnKey(threadBindings, "spawnAcpSessions")),
  );
}

type ThreadBindingMigrationParams = {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
};

function resolveMigratedSpawnSessions(
  threadBindings: Record<string, unknown>,
): boolean | undefined {
  const subagent = threadBindings.spawnSubagentSessions;
  const acp = threadBindings.spawnAcpSessions;
  const subagentBool = typeof subagent === "boolean" ? subagent : undefined;
  const acpBool = typeof acp === "boolean" ? acp : undefined;
  if (subagentBool === undefined) {
    return acpBool;
  }
  if (acpBool === undefined) {
    return subagentBool;
  }
  return subagentBool && acpBool;
}

function migrateThreadBindingsSpawnSessionsForPath(params: ThreadBindingMigrationParams): void {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasLegacyThreadBindingSpawnSplit(threadBindings)) {
    return;
  }

  const hadSpawnSessions = threadBindings.spawnSessions !== undefined;
  const resolved = resolveMigratedSpawnSessions(threadBindings);
  const oldSubagent = threadBindings.spawnSubagentSessions;
  const oldAcp = threadBindings.spawnAcpSessions;
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
  const channels = getRecord(value);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((entry) => {
    const channel = getRecord(entry);
    if (!channel) {
      return false;
    }
    return (
      hasLegacyThreadBindingSpawnSplit(channel.threadBindings) ||
      Object.values(getRecord(channel.accounts) ?? {}).some((account) =>
        hasLegacyThreadBindingSpawnSplit(getRecord(account)?.threadBindings),
      )
    );
  });
}

const THREAD_BINDING_RULES: LegacyConfigRule[] = [
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
];

/** Legacy config migration specs for channel-owned compatibility keys. */
export const LEGACY_CONFIG_MIGRATIONS_CHANNELS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "thread-bindings.spawn-sessions",
    describe: "Consolidate thread session spawning flags (session + channel configs)",
    legacyRules: THREAD_BINDING_RULES,
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
  }),
];
