import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainCachedOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  readCommittedSessionEntryCache,
  readSessionEntryCache,
  retainPreparedSessionGenerationFacts,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { loadTranscriptEvents } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const failures = vi.hoisted(() => ({
  publication: undefined as Error | undefined,
}));

vi.mock("./session-accessor.sqlite-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-identity.js")>();
  return {
    ...actual,
    prepareLifecycleIdentityPublication: (
      ...args: Parameters<typeof actual.prepareLifecycleIdentityPublication>
    ) => {
      const publish = actual.prepareLifecycleIdentityPublication(...args);
      return () => {
        if (failures.publication) {
          throw failures.publication;
        }
        publish();
      };
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  resetConfigRuntimeState();
  const config = { session: { maintenance: { mode: "warn" as const } } };
  setRuntimeConfigSnapshot(config, config);
});

afterEach(async () => {
  failures.publication = undefined;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  resetConfigRuntimeState();
});

it.each(["success", "publication", "writer return", "rollback"] as const)(
  "records the committed lifecycle before %s settlement",
  async (outcome) => {
    const stateDir = tempDirs.make("session-lifecycle-publication-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: "agent:main:lifecycle-publication",
    };
    const entry = { sessionId: "committed-session", updatedAt: 1, label: "Committed row" };
    const failure = new Error(`synthetic ${outcome} failure`);
    failures.publication = outcome === "publication" ? failure : undefined;
    const events: string[] = [];
    const committed = vi.fn(() => {
      expect(database.db.isTransaction).toBe(false);
      expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
      events.push("committed");
    });
    const unsubscribe = onSessionIdentityMutation((mutation) => {
      if (mutation.kind === "create" && mutation.current.sessionKeys.includes(scope.sessionKey)) {
        events.push("published");
      }
    });
    try {
      const operation = applySessionEntryLifecycleMutation({
        agentId: scope.agentId,
        storePath: scope.storePath,
        upserts: [{ sessionKey: scope.sessionKey, entry }],
        skipMaintenance: true,
        onLifecycleCommitted: committed,
        withCommit:
          outcome === "writer return"
            ? async (run) => {
                // Fail after the real commit, publication, and writer release have settled.
                await run(() => {});
                throw failure;
              }
            : undefined,
        ...(outcome === "rollback"
          ? {
              afterUpsertsInTransaction: () => {
                throw failure;
              },
            }
          : {}),
      });
      if (outcome === "success") {
        await operation;
      } else {
        await expect(operation).rejects.toBe(failure);
      }
      expect(committed).toHaveBeenCalledTimes(outcome === "rollback" ? 0 : 1);
      expect(events).toEqual(
        outcome === "rollback"
          ? []
          : outcome === "publication"
            ? ["committed"]
            : ["committed", "published"],
      );
      if (outcome === "rollback") {
        expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
      } else {
        expect(loadSessionEntryReadOnly(scope)).toMatchObject(entry);
      }
    } finally {
      unsubscribe();
    }
  },
);

it("publishes removal invalidations before identity and row observers without archive intent", async () => {
  const stateDir = tempDirs.make("session-lifecycle-removal-publication-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const storePath = path.join(stateDir, "sessions.json");
  const scope = {
    sessionId: "session-1",
    sessionKey: "agent:main:preserve",
    storePath,
  };
  await upsertSessionEntryCore(scope, {
    restartRecoveryDeliveryContext: {
      channel: "whatsapp",
      to: "+15551234567",
    },
    restartRecoveryDeliveryRunId: "old-run",
    sessionId: scope.sessionId,
    updatedAt: 10,
  });
  const owner = { id: "lifecycle-owner", type: "human" as const };
  assignSessionOwner(scope, { assignedBy: owner, owner });
  await replaceTranscriptEvents(scope, [
    {
      id: "event-1",
      message: { role: "user", content: "keep me" },
      type: "message",
    },
  ]);

  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  const identity = readOpenClawAgentDatabaseIdentity(database).identity;
  const entry = loadSessionEntry(scope);
  if (typeof identity !== "string" || !entry) {
    throw new Error("Expected a persisted lifecycle removal fixture");
  }
  const reader = retainCachedOpenClawAgentDatabaseReadOnly({ agentId: "main", path: target.path });
  if (!reader.found) {
    throw new Error("Expected a retained lifecycle reader");
  }
  const sharingEntry = projectSessionSharingEntry(entry);
  const sharing = retainPreparedSessionSharingFacts({
    databaseIdentity: `file:${identity}`,
    sessionKey: scope.sessionKey,
    entry: sharingEntry,
    membership: new Set(["member"]),
  });
  const acquiring = retainPreparedSessionSharingFacts({
    databaseIdentity: `file:${identity}`,
    sessionKey: scope.sessionKey,
    acquiring: true,
  });
  const generation = retainPreparedSessionGenerationFacts({
    databaseIdentity: `file:${identity}`,
    sessionKey: scope.sessionKey,
    entry: sharingEntry,
  });
  readSessionEntryCache(database, { cache: true });
  readSessionEntryCache(reader.database, { cache: true });
  expect(readCommittedSessionEntryCache(database.db)?.has(scope.sessionKey)).toBe(true);
  expect(readCommittedSessionEntryCache(reader.database.db)?.has(scope.sessionKey)).toBe(true);
  expect(sharing.readCurrent()?.entry).toEqual(sharingEntry);
  expect(generation.readCurrent()).toEqual(sharingEntry);
  const order: string[] = [];
  const observedFacts: Array<{
    invalidated: boolean;
    ownerTagged: boolean;
    sharing: ReturnType<typeof sharing.readCurrent>;
    generation: ReturnType<typeof generation.readCurrent>;
    writableCache: ReturnType<typeof readCommittedSessionEntryCache>;
    readOnlyCache: ReturnType<typeof readCommittedSessionEntryCache>;
  }> = [];
  const stopFacts = sessionChanges.subscribeFacts((change) => {
    if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
      return;
    }
    order.push("facts");
    observedFacts.push({
      invalidated: change.factsInvalidated === true,
      ownerTagged: isPreparedSessionSharingChange(change),
      sharing: sharing.readCurrent(),
      generation: generation.readCurrent(),
      writableCache: readCommittedSessionEntryCache(database.db),
      readOnlyCache: readCommittedSessionEntryCache(reader.database.db),
    });
  });
  const stopProjection = sessionChanges.subscribeProjection((change) => {
    if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
      order.push("projection");
    }
  });
  const notify = vi.fn();
  const stopIdentity = onSessionIdentityMutation((mutation) => {
    notify(mutation);
    if (mutation.kind === "delete" && mutation.previous.sessionKeys.includes(scope.sessionKey)) {
      order.push("identity");
    }
  });
  const rowPaths: Array<string | undefined> = [];
  const stopRows = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
      rowPaths.push(change.storePath);
      order.push("row");
    }
  });
  const lifecycleFacts: unknown[] = [];
  try {
    const result = await applySessionEntryLifecycleMutation({
      storePath,
      onLifecycleCommitted: () => {
        order.push("committed");
        lifecycleFacts.push({
          sharing: sharing.readCurrent(),
          generation: generation.readCurrent(),
          writableCache: readCommittedSessionEntryCache(database.db),
          readOnlyCache: readCommittedSessionEntryCache(reader.database.db),
        });
      },
      removals: [{ expectedSessionId: scope.sessionId, sessionKey: scope.sessionKey }],
    });
    const file = statSync(target.path, { bigint: true });
    expect(result.removedEntries).toBe(1);
    expect(notify).toHaveBeenCalledWith({
      agentId: "main",
      databaseIdentity: `${file.dev}:${file.ino}`,
      kind: "delete",
      previous: { sessionId: scope.sessionId, sessionKeys: [scope.sessionKey] },
    });
    expect(order).toEqual(["facts", "projection", "committed", "identity", "row"]);
    expect(rowPaths).toEqual([database.path]);
    expect(lifecycleFacts).toEqual([
      {
        sharing: undefined,
        generation: undefined,
        writableCache: undefined,
        readOnlyCache: undefined,
      },
    ]);
    expect(observedFacts).toEqual([
      {
        invalidated: true,
        ownerTagged: true,
        sharing: undefined,
        generation: undefined,
        writableCache: undefined,
        readOnlyCache: undefined,
      },
    ]);
    expect(() =>
      acquiring.initialize({ entry: sharingEntry, membership: new Set(["member"]) }),
    ).toThrow("Session sharing acquisition is no longer current");
    expect(result.archivedTranscriptDirectories).toEqual([]);
    expect(loadSessionEntry(scope)).toBeUndefined();
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  } finally {
    stopFacts();
    stopProjection();
    stopIdentity();
    stopRows();
    sharing.release();
    acquiring.release();
    generation.release();
    reader.claim.release();
  }
});
