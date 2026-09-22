import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { assignSessionOwner } from "./session-accessor.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionEntry } from "./types.js";

type Fixture = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
};

export type ClaimTarget = { databaseAgentId: string; databasePath: string; key: string };

export const humanOwner = {
  actor: { type: "human", id: "alice" },
  assignedBy: { type: "human", id: "bob" },
  assignedAt: 123,
} as const;

export function setupLegacyMainSessionMigrationTests() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  afterEach(() => vi.unstubAllEnvs());

  function createFixture(cfg: OpenClawConfig = { agents: { entries: { ops: {} } } }): Fixture {
    const rawRoot = tempDirs.make("openclaw-legacy-main-session-");
    const root = fs.realpathSync.native(rawRoot);
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    return {
      cfg,
      env: { ...process.env, OPENCLAW_AGENT_DIR: undefined, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
    };
  }

  return { tempDirs, createFixture };
}

export function databasePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

export function assignHumanOwner(storePath: string): void {
  expect(
    assignSessionOwner(
      { agentId: "main", sessionKey: "agent:main:chat", storePath },
      {
        owner: humanOwner.actor,
        assignedBy: humanOwner.assignedBy,
        assignedAt: humanOwner.assignedAt,
      },
    ),
  ).toEqual(humanOwner);
}

export function seedClaim(
  params: ClaimTarget & {
    entry?: SessionEntry;
    events?: unknown[];
  },
): SessionEntry {
  const entry = params.entry ?? {
    sessionId: `session-${params.key.replaceAll(":", "-")}`,
    updatedAt: 100,
  };
  runOpenClawAgentWriteTransaction(
    (database) => {
      writeSessionEntry(database, params.key, entry, {
        allowStoredAliases: true,
        previousEntry: null,
      });
      for (const event of params.events ?? [{ type: "message", id: "event-1", text: "hello" }]) {
        appendTranscriptEventInTransaction(
          database,
          {
            agentId: params.databaseAgentId,
            path: params.databasePath,
            sessionId: entry.sessionId,
            sessionKey: params.key,
          },
          event,
          { allowStoredAlias: true },
        );
      }
    },
    { agentId: params.databaseAgentId, path: params.databasePath },
  );
  return entry;
}

export function readClaim(params: ClaimTarget) {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const entry = readExactSessionEntryRowForCanonicalRepair(database, params.key)?.entry;
      return entry
        ? {
            entry,
            events: readTranscriptEventRows(database, entry.sessionId).map((row) => row.eventJson),
          }
        : undefined;
    },
    { agentId: params.databaseAgentId, path: params.databasePath },
  );
}

export function outcomeKinds(result: Awaited<ReturnType<typeof migrateLegacyMainSessionKeys>>) {
  return result.outcomes.map((outcome) => outcome.kind);
}

export async function recordHarnessDeletions<T>(
  run: () => Promise<T>,
  beforePrepare?: () => void | Promise<void>,
) {
  const registry = createEmptyPluginRegistry();
  const committed: string[] = [];
  registry.agentHarnesses.push({
    pluginId: "core",
    source: "test",
    harness: {
      id: "migration-fixture",
      label: "Migration fixture",
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("unused");
      },
      async withSessionDeletion(params, next) {
        await beforePrepare?.();
        return next({
          commit() {
            params.assertCurrent();
            committed.push(params.sessionKey);
          },
          rollback() {
            committed.splice(committed.lastIndexOf(params.sessionKey), 1);
          },
        });
      },
    },
  });
  markPluginRegistryActive(registry);
  try {
    return { result: await withPluginRuntimeRegistryScope(registry, run), committed };
  } finally {
    markPluginRegistryRetired(registry);
  }
}
