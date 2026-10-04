import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionEntryLifecycleUpsertConflictError } from "./session-accessor.lifecycle-types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

vi.mock("./session-accessor.sqlite-maintenance-kick.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-maintenance-kick.js")>()),
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-history-eviction.js")>()),
  kickSessionHistoryDiskBudgetMaintenance() {},
}));

const delivery = vi.hoisted(() => ({
  currentCommand: "",
  afterCommit: undefined as ((type: string) => void) | undefined,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owner = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(
            source,
            (worker) =>
              operation({
                execute: async (command, commandOptions) => {
                  delivery.currentCommand = command.type;
                  try {
                    const result = await worker.execute(command, commandOptions);
                    delivery.afterCommit?.(command.type);
                    return result;
                  } finally {
                    delivery.currentCommand = "";
                  }
                },
              }),
            options,
          ),
      };
    },
  };
});

afterEach(() => {
  delivery.afterCommit = undefined;
  delivery.currentCommand = "";
  vi.restoreAllMocks();
});

function fixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    storePath: database.path,
    sessionKey: "agent:main:lifecycle-worker",
  };
  const initial = {
    sessionId: "lifecycle-original",
    updatedAt: Date.now(),
    skillsSnapshot: { prompt: "original saved prompt", skills: [] },
    sessionDiffBaseline: {
      version: 1 as const,
      sessionId: "lifecycle-original",
      root: "/synthetic",
      files: [],
    },
  };
  replaceSessionEntrySync(scope, initial);
  return {
    scope,
    initial,
    read: (sessionKey = scope.sessionKey) => readExactSessionEntryRow(database, sessionKey)?.entry,
  };
}

it("moves lifecycle counts and snapshot writes off the host while preserving maintenance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const siblingKey = "agent:main:lifecycle-old";
    const createdKey = "agent:main:lifecycle-new";
    const now = Date.now();
    replaceSessionEntrySync(
      { ...f.scope, sessionKey: siblingKey },
      { sessionId: "old-sibling", updatedAt: now - 86_400_000 },
    );
    const snapshots = { prompt: "replacement saved prompt", skills: [] };
    const sql = observeHostDataSql();
    try {
      const result = await applySessionEntryLifecycleMutation({
        ...f.scope,
        activeSessionKey: f.scope.sessionKey,
        upserts: [
          {
            sessionKey: f.scope.sessionKey,
            entry: { sessionId: f.initial.sessionId, updatedAt: now, skillsSnapshot: snapshots },
          },
          { sessionKey: createdKey, entry: { sessionId: "new-session", updatedAt: now + 1 } },
        ],
        maintenanceOverride: {
          mode: "enforce",
          maxEntries: 2,
          pruneAfterMs: 30 * 86_400_000,
          preserveRecentMs: null,
        },
      });
      expect(result).toMatchObject({
        beforeCount: 2,
        afterCount: 3,
        archived: 1,
        capArchived: 1,
        capped: 1,
        pruned: 0,
        removedEntries: 0,
      });
      const movedQueries = sql.queries.filter(
        (query) =>
          /\bcount\s*\(\s*\*\s*\)[\s\S]*\bfrom\s+"?session_nodes\b/i.test(query) ||
          /\b(?:delete\s+from|insert\s+into|update)\s+"?session_entry_snapshots\b/i.test(query),
      );
      expect(movedQueries).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(f.read()?.skillsSnapshot).toEqual(snapshots);
    expect(f.read()?.sessionDiffBaseline).toBeUndefined();
    expect(f.read(siblingKey)).toMatchObject({ archiveReason: "active-session-cap" });
    expect(f.read(createdKey)).toMatchObject({ sessionId: "new-session" });
  });
});

it("retains conflict identity and the concurrent row when a prepared upsert is stale", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const concurrent = { ...f.initial, label: "concurrent winner" };
    let expected = f.read();
    const buildEntry = vi.fn(() => ({ ...f.initial, label: "stale replacement" }));
    const committed = vi.fn();
    const operation = applySessionEntryLifecycleMutation({
      ...f.scope,
      skipMaintenance: true,
      upserts: [{ sessionKey: f.scope.sessionKey, buildEntry }],
      onLifecycleCommitted: committed,
      withCommit: async (run) => {
        replaceSessionEntrySync(f.scope, concurrent);
        expected = f.read();
        return run(() => {});
      },
    });
    await expect(operation).rejects.toBeInstanceOf(SessionEntryLifecycleUpsertConflictError);
    await expect(operation).rejects.toMatchObject({ sessionKey: f.scope.sessionKey });
    expect(buildEntry).toHaveBeenCalledOnce();
    expect(committed).not.toHaveBeenCalled();
    expect(f.read()).toEqual(expected);
  });
});

it.each([
  { stage: "transaction", preservation: false },
  { stage: "commit", preservation: false },
  { stage: "commit", preservation: true },
] as const)(
  "rolls back snapshots at the $stage grant (preservation=$preservation)",
  async ({ stage, preservation }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const before = f.read();
      const refusal = new Error("lifecycle authority revoked");
      const committed = vi.fn();
      let live = true;
      let revokedAtGrant = false;
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            if (
              delivery.currentCommand === "session.lifecycle.project" &&
              request.stage === stage
            ) {
              live = false;
              revokedAtGrant = true;
            }
            callback(request, grant);
          }, attachment),
      );
      const stopPreserving = preservation
        ? registerSessionMaintenancePreserveKeysProvider(() => (live ? [] : [f.scope.sessionKey]))
        : undefined;
      try {
        const operation = applySessionEntryLifecycleMutation({
          ...f.scope,
          activeSessionKey: f.scope.sessionKey,
          skipMaintenance: !preservation,
          ...(preservation ? { maintenanceOverride: { mode: "enforce" as const } } : {}),
          upserts: [
            { sessionKey: f.scope.sessionKey, entry: { sessionId: "vetoed", updatedAt: 2 } },
          ],
          commitGuard: () => {
            if (!live && !preservation) {
              throw refusal;
            }
          },
          onLifecycleCommitted: committed,
        });
        if (preservation) {
          await expect(operation).rejects.toThrow("Session maintenance protection changed");
        } else {
          await expect(operation).rejects.toBe(refusal);
        }
        expect(revokedAtGrant).toBe(true);
        expect(committed).not.toHaveBeenCalled();
        expect(f.read()).toEqual(before);
      } finally {
        stopPreserving?.();
      }
    });
  },
);

it("publishes the acknowledged lifecycle once after losing its worker reply", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const createdKey = "agent:main:lifecycle-acknowledged";
    const order: string[] = [];
    const committed = vi.fn(() => order.push("committed"));
    const buildEntry = vi.fn(() => ({ sessionId: "acknowledged", updatedAt: Date.now() }));
    const lostReply = vi.fn();
    delivery.afterCommit = (type) => {
      if (type === "session.lifecycle.project") {
        lostReply();
        throw new Error("worker reply lost after COMMIT");
      }
    };
    const stop = onSessionIdentityMutation((change) => {
      if (change.kind === "create" && change.current.sessionKeys.includes(createdKey)) {
        order.push("identity");
      }
    });
    try {
      await expect(
        applySessionEntryLifecycleMutation({
          ...f.scope,
          skipMaintenance: true,
          upserts: [{ sessionKey: createdKey, buildEntry }],
          onLifecycleCommitted: committed,
        }),
      ).resolves.toMatchObject({ beforeCount: 1, afterCount: 2 });
      expect(f.read(createdKey)?.sessionId).toBe("acknowledged");
      expect(lostReply).toHaveBeenCalledOnce();
      expect(buildEntry).toHaveBeenCalledOnce();
      expect(committed).toHaveBeenCalledOnce();
      expect(order).toEqual(["committed", "identity"]);
    } finally {
      stop();
    }
  });
});
