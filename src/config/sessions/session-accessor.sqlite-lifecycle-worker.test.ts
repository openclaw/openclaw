import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as subagentReads from "../../agents/subagents/registry/subagent-registry-read.js";
import { sweepCronRunSessions } from "../../cron/session-reaper.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionEntryLifecycleUpsertConflictError } from "./session-accessor.lifecycle-error.js";
import * as lifecycleArchives from "./session-accessor.sqlite-archive.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.js";

it("keeps bulk lifecycle SQL off the caller while retaining projected references and typed conflicts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const retainedKey = "agent:main:lifecycle-retained";
    const removedKey = "agent:main:lifecycle-removed";
    const survivorKey = "agent:main:lifecycle-survivor";
    for (const [sessionKey, sessionId] of [
      [retainedKey, "retained"],
      [removedKey, "removed"],
      [survivorKey, "survivor"],
    ] as const) {
      writeSessionEntry(database, sessionKey, { sessionId, updatedAt: 1 });
    }
    const scope = {
      agentId: "main",
      storePath: database.path,
      sessionKey: retainedKey,
      sessionId: "retained",
    };
    const events = [{ type: "session", id: "retained", content: "retained lifecycle history" }];
    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    const prototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const prepare = vi.spyOn(prototype, "prepare");
    const exec = vi.spyOn(database.db, "exec");
    try {
      const result = await applySessionEntryLifecycleMutation({
        agentId: "main",
        storePath: database.path,
        skipMaintenance: true,
        removals: [retainedKey, removedKey].map((sessionKey) => ({
          sessionKey,
          archiveRemovedTranscript: true,
        })),
        upserts: [
          {
            sessionKey: survivorKey,
            buildEntry: ({ currentEntry }) => ({
              ...currentEntry!,
              usageFamilySessionIds: ["retained"],
            }),
          },
        ],
      });
      expect(result).toMatchObject({ beforeCount: 3, afterCount: 1, removedEntries: 2 });
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("projected_nodes"))).toEqual([]);
      expect(exec.mock.calls.filter(([sql]) => /\bBEGIN\s+IMMEDIATE\b/i.test(sql))).toEqual([]);
    } finally {
      prepare.mockRestore();
      exec.mockRestore();
    }
    expect(readExactSessionEntryRow(database, retainedKey)).toBeUndefined();
    expect(readExactSessionEntryRow(database, removedKey)).toBeUndefined();
    expect(readExactSessionEntryRow(database, survivorKey)?.entry.usageFamilySessionIds).toEqual([
      "retained",
    ]);
    expect(loadTranscriptEventsSync(scope)).toEqual(events);

    const enlargedPrompt = "x".repeat(2 * 1024 * 1024 + 1);
    for (const enlarged of [false, true]) {
      const notifyCommitted = vi.fn();
      const stale = applySessionEntryLifecycleMutation({
        agentId: "main",
        storePath: database.path,
        skipMaintenance: true,
        onLifecycleCommitted: notifyCommitted,
        upserts: [
          {
            sessionKey: survivorKey,
            buildEntry: ({ currentEntry }) => {
              writeSessionEntry(database, survivorKey, {
                ...currentEntry!,
                label: "newer",
                ...(enlarged ? { skillsSnapshot: { prompt: enlargedPrompt, skills: [] } } : {}),
              });
              return { ...currentEntry!, label: "stale" };
            },
          },
        ],
      });
      await expect(stale).rejects.toBeInstanceOf(SessionEntryLifecycleUpsertConflictError);
      expect(notifyCommitted).not.toHaveBeenCalled();
      expect(readExactSessionEntryRow(database, survivorKey)?.entry.label).toBe("newer");
    }
    let nativeGuards = 0;
    await applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath: database.path,
      skipMaintenance: true,
      upserts: [
        {
          sessionKey: survivorKey,
          entry: { sessionId: "survivor", updatedAt: 2, label: "native" },
        },
      ],
      beforeCommitInTransaction() {
        nativeGuards++;
        expect(database.db.isTransaction).toBe(true);
      },
    });
    expect(nativeGuards).toBe(1);
    expect(readExactSessionEntryRow(database, survivorKey)?.entry.label).toBe("native");

    const committed = vi.fn();
    const admission = workerAdmission.createSqliteWorkerOperationAdmission;
    let current = true;
    const revoke = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback) =>
        admission((request, grant) => {
          if (request.stage === "commit") {
            current = false;
          }
          callback(request, grant);
        }),
      );
    try {
      await expect(
        applySessionEntryLifecycleMutation({
          agentId: "main",
          storePath: database.path,
          skipMaintenance: true,
          upserts: [
            {
              sessionKey: survivorKey,
              entry: { sessionId: "survivor", updatedAt: 3, label: "refused" },
            },
          ],
          onLifecycleCommitted: committed,
          withCommit: (run) =>
            run(() => {
              if (!current) {
                throw new Error("Synthetic lifecycle commit authority revoked");
              }
            }),
        }),
      ).rejects.toThrow("Synthetic lifecycle commit authority revoked");
      expect(committed).not.toHaveBeenCalled();
      expect(readExactSessionEntryRow(database, survivorKey)?.entry.label).toBe("native");
    } finally {
      revoke.mockRestore();
    }

    const sideKey = "agent:main:lifecycle-uncommitted-side";
    const removedCommitted = vi.fn();
    await expect(
      applySessionEntryLifecycleMutation({
        agentId: "main",
        storePath: database.path,
        skipMaintenance: true,
        removals: [{ sessionKey: survivorKey }],
        upserts: [{ sessionKey: sideKey, entry: { sessionId: "side", updatedAt: 1 } }],
        onLifecycleCommitted: removedCommitted,
        withCommit: (run) => {
          writeSessionEntry(database, survivorKey, {
            ...readExactSessionEntryRow(database, survivorKey)!.entry,
            updatedAt: 3,
            label: "enlarged",
            skillsSnapshot: { prompt: enlargedPrompt, skills: [] },
          });
          return run(() => {});
        },
      }),
    ).rejects.toThrow(`SQLite session entry changed before lifecycle removal for ${survivorKey}`);
    expect(removedCommitted).not.toHaveBeenCalled();
    expect(readExactSessionEntryRow(database, sideKey)).toBeUndefined();
    expect(readExactSessionEntryRow(database, survivorKey)?.entry.label).toBe("enlarged");

    const archiveKey = "agent:main:lifecycle-archive-failure";
    for (const sameKeyUpsert of [false, true]) {
      const original = { sessionId: "archive-failure", updatedAt: 1 };
      writeSessionEntry(database, archiveKey, original);
      const failure = new Error("synthetic archive materialization failure");
      const notifyCommitted = vi.fn();
      const materialize = vi
        .spyOn(lifecycleArchives, "materializeSessionStateDeletePlans")
        .mockImplementation(async () => {
          writeSessionEntry(database, archiveKey, {
            ...readExactSessionEntryRow(database, archiveKey)!.entry,
            label: "enlarged archive",
            skillsSnapshot: { prompt: enlargedPrompt, skills: [] },
          });
          throw failure;
        });
      try {
        const mutation = applySessionEntryLifecycleMutation({
          agentId: "main",
          storePath: database.path,
          skipMaintenance: true,
          captureArtifactCleanupError: true,
          removals: [{ sessionKey: archiveKey, archiveRemovedTranscript: true }],
          upserts: [
            {
              sessionKey: sameKeyUpsert ? archiveKey : sideKey,
              entry: sameKeyUpsert
                ? { ...original, sessionId: "replacement" }
                : { sessionId: "side", updatedAt: 1 },
            },
          ],
          onLifecycleCommitted: notifyCommitted,
        });
        if (sameKeyUpsert) {
          await expect(mutation).rejects.toBeInstanceOf(SessionEntryLifecycleUpsertConflictError);
        } else {
          expect((await mutation).artifactCleanupError).toBe(failure);
          expect(readExactSessionEntryRow(database, sideKey)?.entry.sessionId).toBe("side");
        }
        expect(materialize).toHaveBeenCalledTimes(1);
        expect(notifyCommitted).toHaveBeenCalledTimes(sameKeyUpsert ? 0 : 1);
        expect(readExactSessionEntryRow(database, archiveKey)?.entry.label).toBe(
          "enlarged archive",
        );
      } finally {
        materialize.mockRestore();
      }
    }

    vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
    try {
      for (const [index, mode] of (["ordinary", "continuation", "mixed"] as const).entries()) {
        const nowMs = 1_800_000_000_000 + index * 300_000;
        const keys = mode === "mixed" ? ["continuation", "ordinary"] : [mode];
        for (const kind of keys) {
          const sessionKey = `agent:main:cron:lifecycle-${mode}:run:${kind}`;
          writeSessionEntry(database, sessionKey, {
            sessionId: `${mode}-${kind}`,
            updatedAt: nowMs - 25 * 3_600_000,
            ...(kind === "continuation"
              ? { cronRunContinuation: { lifecycleRevision: "original", phase: "ready" as const } }
              : {}),
          });
        }
        const originalDescendants = subagentReads.hasDescendantRunAwaitingSettle;
        const guardTransactions: boolean[] = [];
        const descendants = vi
          .spyOn(subagentReads, "hasDescendantRunAwaitingSettle")
          .mockImplementation((...args) => {
            guardTransactions.push(database.db.isTransaction);
            return originalDescendants(...args);
          });
        const statements = vi.spyOn(prototype, "prepare");
        const warn = vi.fn();
        try {
          expect(
            await sweepCronRunSessions({
              agentId: "main",
              sessionStorePath: database.path,
              nowMs,
              log: { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() },
            }),
          ).toEqual({ swept: true, pruned: keys.length });
          expect(warn).not.toHaveBeenCalled();
          const referenceQueries = statements.mock.calls.filter(([sql]) =>
            sql.includes("projected_nodes"),
          );
          if (mode === "ordinary") {
            expect(referenceQueries).toEqual([]);
            expect(guardTransactions).toEqual([]);
          } else {
            expect(referenceQueries.length).toBeGreaterThan(0);
            expect(guardTransactions).toEqual([false, true]);
          }
        } finally {
          descendants.mockRestore();
          statements.mockRestore();
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
