import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  type SessionEntryLifecycleUpsert,
  SessionEntryLifecycleUpsertConflictError,
} from "./session-accessor.lifecycle-types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import * as reclamation from "./session-accessor.sqlite-reclamation-commit.js";
import { SessionMaintenancePreservationConflictError } from "./session-mutation-conflict-error.js";
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
  beforeCommand: undefined as ((type: string) => Promise<void>) | undefined,
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
                    if (delivery.beforeCommand) {
                      await delivery.beforeCommand(command.type);
                    }
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
  delivery.beforeCommand = undefined;
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

function maintenanceFixture() {
  const f = fixture();
  const siblingKey = "agent:main:lifecycle-old";
  const siblingId = "old-sibling";
  const createdKey = "agent:main:lifecycle-new";
  const now = Date.now();
  replaceSessionEntrySync(
    { ...f.scope, sessionKey: siblingKey },
    { sessionId: siblingId, updatedAt: now - 86_400_000 },
  );
  return {
    ...f,
    siblingKey,
    siblingId,
    createdKey,
    upserts: [
      {
        sessionKey: f.scope.sessionKey,
        entry: {
          sessionId: f.initial.sessionId,
          updatedAt: now,
          skillsSnapshot: { prompt: "replacement saved prompt", skills: [] },
        },
      },
      { sessionKey: createdKey, entry: { sessionId: "new-session", updatedAt: now + 1 } },
    ] satisfies [SessionEntryLifecycleUpsert, SessionEntryLifecycleUpsert],
    maintenanceOverride: {
      mode: "enforce" as const,
      maxEntries: 2,
      pruneAfterMs: 30 * 86_400_000,
      preserveRecentMs: null,
    },
  };
}

function atLifecycleCommit(run: () => void) {
  const changed = vi.fn(run);
  const create = admission.createSqliteWorkerOperationAdmission;
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (callback, attachment) =>
      create((request, grant) => {
        if (delivery.currentCommand === "session.lifecycle.project" && request.stage === "commit") {
          changed();
        }
        callback(request, grant);
      }, attachment),
  );
  return changed;
}

it("moves lifecycle counts and snapshot writes off the host while preserving maintenance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = maintenanceFixture();
    const sql = observeHostDataSql();
    try {
      const result = await applySessionEntryLifecycleMutation({
        ...f.scope,
        activeSessionKey: f.scope.sessionKey,
        upserts: f.upserts,
        maintenanceOverride: f.maintenanceOverride,
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
    expect(f.read()?.skillsSnapshot).toEqual(f.upserts[0].entry.skillsSnapshot);
    expect(f.read()?.sessionDiffBaseline).toBeUndefined();
    expect(f.read(f.siblingKey)).toMatchObject({ archiveReason: "active-session-cap" });
    expect(f.read(f.createdKey)).toMatchObject({ sessionId: "new-session" });
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

it.each(["transaction", "commit"] as const)(
  "rolls back snapshots at the %s grant",
  async (stage) => {
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
      const operation = applySessionEntryLifecycleMutation({
        ...f.scope,
        activeSessionKey: f.scope.sessionKey,
        skipMaintenance: true,
        upserts: [{ sessionKey: f.scope.sessionKey, entry: { sessionId: "vetoed", updatedAt: 2 } }],
        commitGuard: () => {
          if (!live) {
            throw refusal;
          }
        },
        onLifecycleCommitted: committed,
      });
      await expect(operation).rejects.toBe(refusal);
      expect(revokedAtGrant).toBe(true);
      expect(committed).not.toHaveBeenCalled();
      expect(f.read()).toEqual(before);
    });
  },
);

it.each([
  "provider key",
  "lifecycle session id",
  "work session id",
  "work normalized key",
] as const)(
  "rolls back snapshots when an archived sibling gains protection by %s before commit",
  async (identityKind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = maintenanceFixture();
      const before = f.read();
      const siblingBefore = f.read(f.siblingKey);
      const committed = vi.fn();
      let preserve = false;
      const release = createDeferredCore();
      let lifecycle: Promise<void> | undefined;
      let work: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      const stopPreserving = registerSessionMaintenancePreserveKeysProvider(() =>
        preserve ? [f.siblingKey] : [],
      );
      const changed = atLifecycleCommit(() => {
        if (identityKind === "provider key") {
          preserve = true;
        } else if (identityKind === "lifecycle session id") {
          lifecycle = runExclusiveSessionLifecycleMutation("patch", {
            scope: f.scope.storePath,
            identities: [` ${f.siblingId} `],
            run: () => release.promise,
          });
          expect(isSessionLifecycleMutationActive(f.scope.storePath, [f.siblingId])).toBe(true);
        }
      });
      delivery.beforeCommand = async (type) => {
        if (type === "session.lifecycle.project" && identityKind.startsWith("work ")) {
          work = await beginSessionWorkAdmission({
            scope: f.scope.storePath,
            identities: [
              identityKind === "work session id"
                ? ` ${f.siblingId} `
                : " AGENT:MAIN:LIFECYCLE-OLD ",
            ],
            assertAllowed: () => {},
          });
        }
      };
      try {
        const operation = applySessionEntryLifecycleMutation({
          ...f.scope,
          activeSessionKey: f.scope.sessionKey,
          upserts: f.upserts,
          maintenanceOverride: f.maintenanceOverride,
          onLifecycleCommitted: committed,
        });
        await expect(operation).rejects.toBeInstanceOf(SessionMaintenancePreservationConflictError);
        await expect(operation).rejects.toThrow(
          "Session maintenance protection changed before lifecycle commit",
        );
        expect(changed).toHaveBeenCalledOnce();
        expect(committed).not.toHaveBeenCalled();
        expect(f.read()).toEqual(before);
        expect(f.read(f.siblingKey)).toEqual(siblingBefore);
        expect(f.read(f.createdKey)).toBeUndefined();
      } finally {
        work?.release();
        stopPreserving();
        release.resolve();
        await lifecycle;
      }
    });
  },
);

it("commits when unrelated maintenance protection changes before the commit grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = maintenanceFixture();
    const committed = vi.fn();
    let preserve = ["agent:main:unrelated-old"];
    const stopPreserving = registerSessionMaintenancePreserveKeysProvider(() => preserve);
    const changed = atLifecycleCommit(() => {
      preserve = ["agent:main:unrelated-new"];
    });
    try {
      await expect(
        applySessionEntryLifecycleMutation({
          ...f.scope,
          activeSessionKey: f.scope.sessionKey,
          upserts: f.upserts,
          maintenanceOverride: f.maintenanceOverride,
          onLifecycleCommitted: committed,
        }),
      ).resolves.toMatchObject({
        beforeCount: 2,
        afterCount: 3,
        archived: 1,
        capArchived: 1,
        capped: 1,
        pruned: 0,
        removedEntries: 0,
      });
      expect(changed).toHaveBeenCalledOnce();
      expect(committed).toHaveBeenCalledOnce();
      expect(f.read()?.skillsSnapshot).toEqual(f.upserts[0].entry.skillsSnapshot);
      expect(f.read(f.siblingKey)).toMatchObject({ archiveReason: "active-session-cap" });
      expect(f.read(f.createdKey)).toMatchObject({ sessionId: "new-session" });
    } finally {
      stopPreserving();
    }
  });
});

it("ignores protection that disappeared before the commit grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = maintenanceFixture();
    const siblingBefore = f.read(f.siblingKey);
    const committed = vi.fn();
    let preserve = true;
    const stopPreserving = registerSessionMaintenancePreserveKeysProvider(() =>
      preserve ? [f.siblingKey] : [],
    );
    const changed = atLifecycleCommit(() => {
      preserve = false;
    });
    try {
      await expect(
        applySessionEntryLifecycleMutation({
          ...f.scope,
          activeSessionKey: f.scope.sessionKey,
          upserts: f.upserts,
          maintenanceOverride: f.maintenanceOverride,
          onLifecycleCommitted: committed,
        }),
      ).resolves.toMatchObject({ beforeCount: 2, afterCount: 3, archived: 1, capped: 1 });
      expect(changed).toHaveBeenCalledOnce();
      expect(committed).toHaveBeenCalledOnce();
      expect(f.read()?.skillsSnapshot).toEqual(f.upserts[0].entry.skillsSnapshot);
      expect(f.read(f.siblingKey)).toEqual(siblingBefore);
      expect(f.read(f.createdKey)).toMatchObject({
        sessionId: "new-session",
        archiveReason: "active-session-cap",
      });
    } finally {
      stopPreserving();
    }
  });
});

it.each(["disappeared", "grew"] as const)(
  "allows removal-only reclamation only when protection has not grown (%s)",
  async (drift) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = maintenanceFixture();
      const before = f.read();
      const siblingBefore = f.read(f.siblingKey);
      const created = f.upserts[1];
      replaceSessionEntrySync({ ...f.scope, sessionKey: created.sessionKey }, created.entry);
      const createdBefore = f.read(f.createdKey);
      const committed = vi.fn();
      let changed = false;
      const stopPreserving = registerSessionMaintenancePreserveKeysProvider(() =>
        changed ? (drift === "grew" ? [f.siblingKey, "agent:main:unrelated"] : []) : [f.siblingKey],
      );
      const authorize = reclamation.withSqliteReclamationAuthorization;
      vi.spyOn(reclamation, "withSqliteReclamationAuthorization").mockImplementation(
        (gate, database, assertCurrent, run) =>
          authorize(
            gate,
            database,
            () => {
              changed = true;
              assertCurrent();
            },
            run,
          ),
      );
      try {
        const operation = applySessionEntryLifecycleMutation({
          ...f.scope,
          removals: [{ sessionKey: f.scope.sessionKey, expectedEntry: before }],
          maintenanceOverride: { ...f.maintenanceOverride, maxEntries: 1 },
          onLifecycleCommitted: committed,
        });
        if (drift === "grew") {
          await expect(operation).rejects.toBeInstanceOf(
            SessionMaintenancePreservationConflictError,
          );
          expect(committed).not.toHaveBeenCalled();
          expect(f.read()).toEqual(before);
          expect(f.read(f.createdKey)).toEqual(createdBefore);
        } else {
          await expect(operation).resolves.toMatchObject({
            beforeCount: 3,
            afterCount: 2,
            archived: 1,
            capped: 1,
            removedEntries: 1,
          });
          expect(committed).toHaveBeenCalledOnce();
          expect(f.read()).toBeUndefined();
          expect(f.read(f.createdKey)).toMatchObject({ archiveReason: "active-session-cap" });
        }
        expect(changed).toBe(true);
        expect(f.read(f.siblingKey)).toEqual(siblingBefore);
      } finally {
        stopPreserving();
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
