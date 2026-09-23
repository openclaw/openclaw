import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import {
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";

const failures = vi.hoisted(() => ({
  publication: undefined as Error | undefined,
}));

vi.mock("./session-accessor.sqlite-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-identity.js")>();
  return {
    ...actual,
    publishCommittedSessionIdentity: (
      ...args: Parameters<typeof actual.publishCommittedSessionIdentity>
    ) => {
      if (failures.publication) {
        throw failures.publication;
      }
      actual.publishCommittedSessionIdentity(...args);
    },
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

it.each(
  (["worker", "native"] as const).flatMap((route) =>
    (route === "native"
      ? (["success", "publication", "writer return", "rollback"] as const)
      : (["success", "publication", "writer return"] as const)
    ).map((outcome) => ({
      route,
      outcome,
    })),
  ),
)(
  "records the committed lifecycle before $outcome settlement ($route)",
  async ({ route, outcome }) => {
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
        ...(route === "native"
          ? {
              beforeCommitInTransaction: () => {
                expect(database.db.isTransaction).toBe(true);
              },
            }
          : {}),
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

it.each(["lifecycle", "throwing callback", "replacement"] as const)(
  "settles shared-store publication for the logical agent (%s)",
  async (route) => {
    const callbackThrows = route === "throwing callback";
    const stateDir = tempDirs.make("session-lifecycle-shared-publication-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: `${stateDir}/shared.sqlite`,
    });
    const survivorKey = "agent:ops:survivor";
    const removedKey = "agent:ops:removed";
    const original = { sessionId: "survivor", updatedAt: 1, visibility: "shared" as const };
    writeSessionEntry(database, survivorKey, original);
    writeSessionEntry(database, removedKey, { sessionId: "removed", updatedAt: 1 });
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey: survivorKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const mutations: SessionIdentityMutation[] = [];
    const changes: SessionRowChange[] = [];
    const stopIdentity = onSessionIdentityMutation((mutation) => mutations.push(mutation));
    const stopChanges = sessionChanges.subscribe((change) => changes.push(change));
    const failure = new Error("synthetic committed callback failure");
    const committed = vi.fn(() => {
      expect(sharing.readCurrent()).toBeUndefined();
      if (callbackThrows) {
        throw failure;
      }
    });
    try {
      const operation =
        route === "replacement"
          ? applySessionEntryExactReplacements({
              agentId: "ops",
              storePath: database.path,
              sessionKeys: [removedKey],
              update: () => ({
                result: undefined,
                replacements: [
                  { sessionKey: removedKey, entry: { sessionId: "replacement", updatedAt: 2 } },
                ],
              }),
            })
          : applySessionEntryLifecycleMutation({
              agentId: "ops",
              storePath: database.path,
              removals: [{ sessionKey: removedKey }],
              upserts: [
                { sessionKey: survivorKey, entry: { ...original, visibility: "read-only" } },
              ],
              skipMaintenance: true,
              onLifecycleCommitted: committed,
            });
      if (callbackThrows) {
        await expect(operation).rejects.toBe(failure);
      } else {
        await operation;
      }
      expect(committed).toHaveBeenCalledTimes(route === "replacement" ? 0 : 1);
      expect(sharing.readCurrent()).toMatchObject({
        entry: { visibility: route === "replacement" ? "shared" : "read-only" },
        membership: new Set(["member"]),
      });
      expect(mutations).toEqual([
        {
          agentId: "ops",
          kind: route === "replacement" ? "replace" : "delete",
          previous: { sessionId: "removed", sessionKeys: [removedKey] },
          ...(route === "replacement"
            ? { current: { sessionId: "replacement", sessionKeys: [removedKey] } }
            : {}),
        },
      ]);
      expect(
        changes.filter((change) => "sessionKey" in change).map((change) => change.agentId),
      ).toEqual(route === "replacement" ? ["ops"] : ["ops", "ops"]);
    } finally {
      stopIdentity();
      stopChanges();
      sharing.release();
    }
  },
);
