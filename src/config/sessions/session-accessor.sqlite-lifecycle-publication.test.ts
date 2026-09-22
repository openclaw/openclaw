import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";

const failures = vi.hoisted(() => ({
  publication: undefined as Error | undefined,
  writerReturn: undefined as Error | undefined,
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

vi.mock("./session-accessor.sqlite-deletion.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-deletion.js")>();
  return {
    ...actual,
    runPreparedSqliteSessionWrite: async (
      ...args: Parameters<typeof actual.runPreparedSqliteSessionWrite>
    ) => {
      const result = await actual.runPreparedSqliteSessionWrite(...args);
      if (failures.writerReturn) {
        throw failures.writerReturn;
      }
      return result;
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
  failures.writerReturn = undefined;
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
    failures.writerReturn = outcome === "writer return" ? failure : undefined;
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
