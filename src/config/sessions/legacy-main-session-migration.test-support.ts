import fs from "node:fs";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as registryLifecycle from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import * as stateDb from "../../state/openclaw-state-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { assignSessionOwner } from "./session-accessor.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionEntry } from "./types.js";

export type ClaimTarget = { databaseAgentId: string; databasePath: string; key: string };

export const humanOwner = {
  actor: { type: "human", id: "alice" },
  assignedBy: { type: "human", id: "bob" },
  assignedAt: 123,
} as const;

export function setupLegacyMainSessionMigrationTests() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await agentDb.closeOpenClawAgentDatabasesAsync();
      await stateDb.closeOpenClawStateDatabaseAsync();
      agentDb.closeOpenClawAgentDatabasesForTest();
      stateDb.closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  afterEach(() => vi.unstubAllEnvs());

  function createFixture(cfg: OpenClawConfig = { agents: { entries: { ops: {} } } }) {
    const root = fs.realpathSync.native(tempDirs.make("openclaw-legacy-main-session-"));
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_STATE_DIR: stateDir,
    };
    return { cfg, env, stateDir };
  }

  return { tempDirs, createFixture };
}

export function databasePath(stateDir: string, agentId: string): string {
  return path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

export function assignHumanOwner(storePath: string): void {
  const { actor: owner, ...assignment } = humanOwner;
  assignSessionOwner(
    { agentId: "main", sessionKey: "agent:main:chat", storePath },
    { owner, ...assignment },
  );
}

const claimScope = ({
  databaseAgentId: agentId,
  databasePath: pathname,
  key: sessionKey,
}: ClaimTarget) => ({ agentId, path: pathname, sessionKey });

type SeedClaim = ClaimTarget & { entry?: SessionEntry; events?: unknown[] };
export function seedClaim(params: SeedClaim): SessionEntry {
  const scope = claimScope(params);
  const entry = params.entry ?? {
    sessionId: `session-${params.key.replaceAll(":", "-")}`,
    updatedAt: 100,
  };
  agentDb.runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, params.key, entry, {
      allowStoredAliases: true,
      previousEntry: null,
    });
    for (const event of params.events ?? [{ type: "message", id: "event-1", text: "hello" }]) {
      appendTranscriptEventInTransaction(
        database,
        { ...scope, sessionId: entry.sessionId },
        event,
        { allowStoredAlias: true },
      );
    }
  }, claimScope(params));
  return entry;
}

export function readClaim(params: ClaimTarget) {
  return agentDb.runOpenClawAgentWriteTransaction((database) => {
    const entry = readExactSessionEntryRowForCanonicalRepair(database, params.key)?.entry;
    return (
      entry && {
        entry,
        events: readTranscriptEventRows(database, entry.sessionId).map((row) => row.eventJson),
      }
    );
  }, claimScope(params));
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
  registryLifecycle.markPluginRegistryActive(registry);
  using _ = {
    [Symbol.dispose]: () => registryLifecycle.markPluginRegistryRetired(registry),
  };
  return { result: await withPluginRuntimeRegistryScope(registry, run), committed };
}
