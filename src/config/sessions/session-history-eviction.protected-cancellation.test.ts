import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as lifecycle from "../../sessions/session-controller.lifecycle.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { installHistoryBudgetState } from "./session-history-budget-state.test-support.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

let tempDir: string;
let storePath: string;
const { database, settlePhysicalUsage, setSessionUpdatedAt, sessionExists, readArchiveNames } =
  createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));

installHistoryBudgetState(
  "openclaw-protected-history-cancellation-",
  (_state, dir, store) => {
    tempDir = dir;
    storePath = store;
  },
  false,
);

it.each(["planning", "materialization", "worker", "archived entry"] as const)(
  "retains history after %s cancellation releases pressure",
  async (stage) => {
    const dayMs = 24 * 60 * 60 * 1000;
    const oldestAt = Date.now() - 8 * dayMs;
    const histories = ["protected", "next"].map((name, index) => ({
      sessionKey: `agent:main:${name}-history`,
      sessionId: `${name}-old`,
      nextSessionId: `${name}-live`,
      updatedAt: oldestAt + index,
      content: `retain ${name} history`,
    }));
    for (const { sessionKey, sessionId, updatedAt, content, nextSessionId } of histories) {
      const scope = { sessionKey, storePath };
      const entry = { sessionId, updatedAt };
      await replaceSessionEntry(scope, entry);
      await appendTranscriptMessage(
        { ...scope, sessionId },
        { message: { role: "user", content } },
      );
      if (stage === "archived entry") {
        await replaceSessionEntry(scope, {
          ...entry,
          archivedAt: updatedAt,
          archiveReason: "active-session-cap",
        });
      } else {
        await resetSessionEntryLifecycle({
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          buildNextEntry: () => ({ sessionId: nextSessionId, updatedAt: updatedAt + 1 }),
        });
      }
      setSessionUpdatedAt(sessionId, updatedAt);
    }
    await closeOpenClawAgentDatabaseByPathAsync(database().path);
    const protectedHistory = histories[0]!;
    const beforeEvents = histories.map((history) =>
      loadTranscriptEventsSync({ ...history, storePath }),
    );
    expect(beforeEvents.every((events) => events.length > 0)).toBe(true);
    settlePhysicalUsage();
    // This live peer artifact counts toward pressure but is not an archive-pruning target.
    const peerArtifact = path.join(tempDir, "peer-live.jsonl");
    const peerBytes = 2 * 1024 * 1024;
    fs.writeFileSync(peerArtifact, Buffer.alloc(peerBytes));
    const diskBudget = await import("./disk-budget.js");
    const measure = diskBudget.measureSessionPhysicalDiskUsage;
    const before = await measure(storePath);
    const highWaterBytes = before.totalBytes - peerBytes / 2;
    let protectionChanged = false;
    vi.spyOn(diskBudget, "measureSessionPhysicalDiskUsage").mockImplementation(async (pathname) => {
      if (protectionChanged) {
        expect(lifecycle.isSessionMutationActive(storePath, [protectedHistory.sessionId])).toBe(
          false,
        );
      }
      return await measure(pathname);
    });
    const releasePressure = () => {
      expect(protectionChanged).toBe(false);
      replaceSessionEntrySync(
        { sessionKey: protectedHistory.sessionKey, storePath },
        stage === "archived entry"
          ? {
              sessionId: protectedHistory.sessionId,
              updatedAt: Date.now(),
              archivedAt: protectedHistory.updatedAt,
              archiveReason: "active-session-cap",
            }
          : { sessionId: protectedHistory.nextSessionId, updatedAt: Date.now() },
      );
      fs.unlinkSync(peerArtifact);
      protectionChanged = true;
    };
    if (stage === "planning") {
      const mutate = lifecycle.runSessionMutation;
      vi.spyOn(lifecycle, "runSessionMutation").mockImplementation((params) =>
        mutate({
          ...params,
          run: async () => {
            if (
              !protectionChanged &&
              "scope" in params &&
              params.scope === storePath &&
              Array.from(params.identities).includes(protectedHistory.sessionId)
            ) {
              releasePressure();
            }
            return await params.run();
          },
        }),
      );
    }
    if (stage === "materialization") {
      const archive = await import("./session-accessor.sqlite-archive.js");
      const materialize = archive.materializeSessionHistoryEvictionPlan;
      vi.spyOn(archive, "materializeSessionHistoryEvictionPlan").mockImplementationOnce(
        async (plan) => {
          expect(plan.sessionId).toBe(protectedHistory.sessionId);
          const prepared = await materialize(plan);
          releasePressure();
          return prepared;
        },
      );
    }
    const reclamation = await import("./session-accessor.sqlite-reclamation-run.js");
    const reclaim = reclamation.runSqliteSessionReclamation;
    const reclaimedHistories: Array<{ sessionId: string; deleted: boolean }> = [];
    const reclaimedEntries: Array<{ sessionKey: string; deleted: boolean }> = [];
    vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
      const result = await reclaim(params);
      if (params.plan.kind === "history-eviction" && result.kind === "history-eviction") {
        reclaimedHistories.push({
          sessionId: params.plan.sessionId,
          deleted: result.value.deleted,
        });
      } else if (params.plan.kind === "entry" && result.kind === "entry") {
        reclaimedEntries.push({
          sessionKey: params.plan.deleteParams.target.canonicalKey,
          deleted: result.value.deleted,
        });
      }
      return result;
    });
    let admissionCount = 0;
    const workerOwner = await import("./session-accessor.sqlite-reclamation-worker.js");
    const withWorker = workerOwner.withSqliteReclamationWorker;
    vi.spyOn(workerOwner, "withSqliteReclamationWorker").mockImplementation(
      (options, claim, consume, assertCurrent) =>
        withWorker(
          options,
          claim,
          async (worker) => {
            const run = worker.run.bind(worker);
            const observeRun = vi.spyOn(worker, "run").mockImplementation((params) => {
              const kind = params.plan.kind;
              if (kind !== "history-eviction" && kind !== "entry") {
                return run(params);
              }
              return run({
                ...params,
                withWriteAdmission: async (operation, admission) => {
                  admissionCount++;
                  if ((stage === "worker" || stage === "archived entry") && !protectionChanged) {
                    releasePressure();
                  }
                  return params.withWriteAdmission(operation, admission);
                },
              });
            });
            try {
              return await consume(worker);
            } finally {
              observeRun.mockRestore();
            }
          },
          assertCurrent,
        ),
    );
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes,
        preserveRecentMs: 7 * dayMs,
      },
    });
    expect(protectionChanged).toBe(true);
    expect(fs.existsSync(peerArtifact)).toBe(false);
    if (stage === "materialization" || stage === "worker" || stage === "archived entry") {
      expect(admissionCount).toBeGreaterThan(0);
    }
    for (const [index, history] of histories.entries()) {
      expect(sessionExists(history.sessionId), history.sessionId).toBe(true);
      expect(loadTranscriptEventsSync({ ...history, storePath })).toEqual(beforeEvents[index]);
      expect(readArchiveNames(history.sessionId)).toEqual([]);
    }
    if (stage === "materialization" || stage === "worker") {
      expect(reclaimedHistories).toEqual([
        { sessionId: protectedHistory.sessionId, deleted: false },
      ]);
    } else if (stage === "archived entry") {
      expect(reclaimedEntries).toEqual([
        { sessionKey: protectedHistory.sessionKey, deleted: false },
      ]);
      expect(reclaimedHistories).toEqual([]);
    } else {
      expect(admissionCount).toBe(0);
      expect(reclaimedHistories).toEqual([]);
    }
    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 0 });
    expect(result?.totalBytesAfter).toBeLessThanOrEqual(highWaterBytes);
    expect(result?.totalBytesAfter).toBe((await measure(storePath)).totalBytes);
  },
);
