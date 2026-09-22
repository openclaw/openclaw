import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { expect, test, vi } from "vitest";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as sqliteArchive from "./session-accessor.sqlite-archive.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import {
  createSessionEntryReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";

test("reuses the reclamation connection until thirty minutes after its last operation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const databaseOptions = { ...options, path: openOpenClawAgentDatabase(options).path };
    const plans = Array.from({ length: 4 }, (_, index) => {
      const scope = {
        ...options,
        sessionId: `synthetic-reclamation-idle-${index}`,
        sessionKey: `agent:main:synthetic-reclamation-idle-${index}`,
      };
      ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const entry = loadSessionEntry(scope);
      assert.ok(entry);
      return createSessionEntryReclamationPlan({
        databaseOptions,
        deleteParams: {
          archiveTranscript: false,
          storePath: databaseOptions.path,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        },
        preparedTargetSnapshot: [{ entry, sessionKey: scope.sessionKey }],
        materializedPlans: [],
      });
    });
    const workers: Worker[] = [];
    const spawn = sqliteArchive.createSqliteTranscriptArchiveWorker;
    vi.spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
      const worker = spawn(data);
      workers.push(worker);
      return worker;
    });
    const reclaim = async (index: number) => {
      const diagnostics: SqliteSessionReclamationDiagnostics = {};
      const plan = plans[index];
      assert.ok(plan);
      await runSqliteSessionReclamation({
        forceInProcess: false,
        plan,
        diagnostics,
      });
      expect(
        loadSessionEntry({
          ...options,
          sessionKey: `agent:main:synthetic-reclamation-idle-${index}`,
        }),
      ).toBeUndefined();
      return diagnostics.workerThreadId;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const firstThread = await reclaim(0);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await reclaim(1)).toBe(firstThread);
      await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(await reclaim(2)).toBe(firstThread);
      expect(workers).toHaveLength(1);
      const worker = workers[0];
      assert.ok(worker);
      const exited = once(worker, "exit");
      await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
      await exited;
      expect(await reclaim(3)).not.toBe(firstThread);
      expect(workers).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

test("logs a native reclamation Worker throw with its cause, first frame and hashed session", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
    async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId: "synthetic-reclamation-session",
        sessionKey: "agent:main:synthetic-reclamation-session",
      };
      ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const databaseOptions = {
        agentId: scope.agentId,
        env: state.env,
        path: openOpenClawAgentDatabase(scope).path,
      };
      const entry = loadSessionEntry(scope);
      assert.ok(entry);
      const file = state.path("reclamation.log");
      await fs.writeFile(file, "");
      setLoggerOverride({ level: "info", consoleLevel: "silent", file });
      vi.spyOn(performance, "now").mockReturnValue(0);
      const secret = "synthetic-worker-credential";
      const worker = new Worker(
        `const { parentPort, workerData } = require("node:worker_threads");
     parentPort.once("message", function failReclamation() {
       parentPort.postMessage({ type: "closed", settled: true, cleanupWarnings: [] });
       throw new Error("synthetic reclamation crash for " + workerData.sessionId, {
         cause: new Error("synthetic disk failure; Authorization: Bearer " + workerData.secret),
       });
     });`,
        { eval: true, execArgv: [], workerData: { sessionId: scope.sessionId, secret } },
      );
      const workerThreadId = worker.threadId;
      vi.spyOn(sqliteArchive, "createSqliteTranscriptArchiveWorker").mockReturnValueOnce(worker);
      try {
        await expect(
          runSqliteSessionReclamation({
            forceInProcess: false,
            plan: createSessionEntryReclamationPlan({
              databaseOptions,
              deleteParams: {
                archiveTranscript: false,
                storePath: databaseOptions.path,
                target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
              },
              preparedTargetSnapshot: [{ entry, sessionKey: scope.sessionKey }],
              materializedPlans: [],
            }),
          }),
        ).rejects.toThrow("synthetic reclamation crash");
        expect(worker.threadId).toBe(-1);
        expect(loadSessionEntry(scope)).toEqual(entry);
        await flushLogger();
        const content = await fs.readFile(file, "utf8");
        const records: unknown[] = content
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        expect(records).toEqual([
          expect.objectContaining({
            message: "SQLite reclamation Worker failed",
            "1": expect.objectContaining({
              reclamationKind: "entry",
              sessionIdHash: redactIdentifier(scope.sessionId),
              workerThreadId,
              exitCode: 1,
              outcome: "rejected",
              error: expect.stringContaining(
                `synthetic reclamation crash for ${redactIdentifier(scope.sessionId)} | synthetic disk failure`,
              ),
              errorFrame: expect.stringContaining("at MessagePort.failReclamation"),
            }),
          }),
        ]);
        expect(content).not.toContain(secret);
        expect(content).not.toContain(scope.sessionId);
      } finally {
        await worker.terminate();
        vi.restoreAllMocks();
        await flushLogger();
        setLoggerOverride(null);
      }
    },
  );
});
