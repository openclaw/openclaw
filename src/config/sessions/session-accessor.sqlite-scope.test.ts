import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import * as logging from "../../logging/logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type {
  SqliteSessionArtifactPreparationDiagnostics,
  SqliteSessionReclamationDiagnostics,
  SqliteSessionWriteDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import {
  runExclusiveSqliteSessionWrite,
  resolveSqliteReadScope,
  prepareSqliteTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import { observeSessionArchivePruning } from "./session-history-archive-pruning-diagnostics.js";

afterEach(() => vi.restoreAllMocks());

test.each([undefined, "agent:main:dashboard:incognito-root"])(
  "keeps an explicit incognito root outside the ambient root (key: %s)",
  async (sessionKey) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const root = state.path("captured-root");
      const storePath = path.join(
        root,
        "agents",
        "main",
        "agent",
        "incognito-openclaw-agent.sqlite",
      );
      const scope = { agentId: "main", storePath, sessionKey, sessionId: "captured-session" };
      const resolved = resolveSqliteReadScope(scope);
      expect(resolved).toMatchObject({
        agentId: "main",
        path: storePath,
        env: { OPENCLAW_STATE_DIR: root },
      });
      expect(await prepareSqliteTranscriptReadScope(scope)).toMatchObject(resolved);
      expect(() => resolveSqliteReadScope({ ...scope, env: state.env })).toThrow(
        "does not match its agent and state root",
      );
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

async function readFailedWriterLog(failure: unknown, diagnostics?: SqliteSessionWriteDiagnostics) {
  return await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
    async (state) => {
      const logPath = state.path("sqlite-write.log");
      logging.setLoggerOverride({ level: "warn", file: logPath });
      const operation = diagnostics?.artifactPreparation
        ? "session.lifecycle.artifacts-prepare"
        : "session.transcript.batch";
      try {
        await expect(
          runExclusiveSqliteSessionWrite(
            { agentId: "main", env: state.env },
            async () => {
              throw failure;
            },
            operation,
            diagnostics,
          ),
        ).rejects.toBe(failure);
        await logging.flushLogger();
        const content = await fs.readFile(logPath, "utf8");
        const record: unknown = JSON.parse(content.trim());
        assert.ok(isRecord(record));
        const details = record["1"];
        assert.ok(isRecord(details));
        expect(record["2"]).toBe("SQLite session write failed");
        expect(details.operation).toBe(operation);
        return { content, error: details.error, details };
      } finally {
        await logging.flushLogger();
        logging.resetLogger();
      }
    },
  );
}

test("failed worker file logs preserve redacted error details", async () => {
  const secret = "synthetic-writer-credential-value";
  const message = "synthetic writer failure";
  const causeMessage = `synthetic storage failure; Authorization: Bearer ${secret}`;
  let failure: unknown;
  const worker = new Worker(
    `const { workerData } = require("node:worker_threads");
       throw Object.assign(new Error(workerData.message, { cause: new Error(workerData.causeMessage) }), { code: "SQLITE_BUSY" });`,
    { eval: true, execArgv: [], workerData: { message, causeMessage } },
  );
  try {
    failure = await new Promise<unknown>((resolve, reject) => {
      let received: unknown;
      let receivedError = false;
      worker.once("error", (error) => {
        received = error;
        receivedError = true;
      });
      worker.once("exit", () => {
        if (receivedError) {
          resolve(received);
        } else {
          reject(new Error("Synthetic worker exited without its expected error"));
        }
      });
    });
  } finally {
    await worker.terminate();
  }
  const record = await readFailedWriterLog(failure);
  expect(record.error).toBeTypeOf("string");
  expect(record.error).toContain(message);
  expect(record.error).toContain("synthetic storage failure");
  expect(record.error).toContain("SQLITE_BUSY");
  expect(record.content).not.toContain(secret);
});

test("artifact preparation file logs retain numeric phases without payload fields", async () => {
  const artifactPreparation: SqliteSessionArtifactPreparationDiagnostics = {
    admissionMode: "async",
    admissionMs: 1200.4,
    nodeInventoryMs: 20.6,
    referencePlanningMs: 4.2,
    orphanPlanningMs: 5.1,
    markerScanMs: 19.6,
    nodeRows: 8,
    windowRows: 12,
    referenceIds: 8,
    selectedEntries: 0,
    markerWindows: 2,
    markerRows: 5,
    completed: false,
  };
  Object.assign(artifactPreparation, {
    sessionId: "synthetic-private-session",
    marker: "synthetic-private-marker",
  });
  const record = await readFailedWriterLog(new Error("synthetic planning failure"), {
    artifactPreparation,
  });
  expect(record.details.artifactPreparation).toEqual({
    admissionMode: "async",
    admissionMs: 1200,
    nodeInventoryMs: 21,
    referencePlanningMs: 4,
    orphanPlanningMs: 5,
    markerScanMs: 20,
    nodeRows: 8,
    windowRows: 12,
    referenceIds: 8,
    selectedEntries: 0,
    markerWindows: 2,
    markerRows: 5,
    completed: false,
  });
  expect(record.content).not.toContain("synthetic-private-session");
  expect(record.content).not.toContain("synthetic-private-marker");
});

test("archive pruning file logs whitelist partial stage observations", async () => {
  const archivePruning = {
    trigger: "initial" as const,
    checkpointCalls: 2,
    checkpointIncomplete: 1,
    checkpointMs: 20.6,
    checkpointMaxMs: 19.6,
    completed: false,
    archiveName: "synthetic-private-archive",
    content: "synthetic-private-transcript",
  };
  const record = await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
    async (state) => {
      const logPath = state.path("archive-pruning.log");
      logging.setLoggerOverride({ level: "warn", file: logPath });
      const failure = new Error("synthetic pruning failure");
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      try {
        await expect(
          observeSessionArchivePruning(archivePruning, async () => {
            clock = 1200.4;
            throw failure;
          }),
        ).rejects.toBe(failure);
        await logging.flushLogger();
        const content = await fs.readFile(logPath, "utf8");
        const parsed: unknown = JSON.parse(content.trim());
        assert.ok(isRecord(parsed));
        assert.ok(isRecord(parsed["2"]));
        expect(parsed["1"]).toBe("SQLite session archive pruning failed");
        expect(parsed["2"]).toHaveProperty("elapsedMs", 1200);
        expect(parsed["2"]).not.toHaveProperty("queueWaitMs");
        expect(parsed["2"]).not.toHaveProperty("writerExecutionMs");
        return { content, details: parsed["2"] };
      } finally {
        await logging.flushLogger();
        logging.resetLogger();
      }
    },
  );
  expect(record.details.archivePruning).toEqual({
    trigger: "initial",
    checkpointCalls: 2,
    checkpointIncomplete: 1,
    checkpointMs: 21,
    checkpointMaxMs: 20,
    completed: false,
  });
  expect(record.content).not.toContain("synthetic-private-archive");
  expect(record.content).not.toContain("synthetic-private-transcript");
});

test.each(["ok", "error"] as const)(
  "retains session writer timing in diagnostic events and file metadata (%s)",
  async (outcome) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
      async (state) => {
        const logPath = state.path("sqlite-write.log");
        resetDiagnosticEventsForTest();
        logging.resetLogger();
        logging.setLoggerOverride({ level: "warn", file: logPath });
        const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
        const unsubscribe = onInternalDiagnosticEvent((event) => {
          if (event.type === "log.record") {
            received.push(event);
          }
        });
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const failure = new Error("synthetic writer failure");
        const message =
          outcome === "ok" ? "slow SQLite session write" : "SQLite session write failed";
        const fields = {
          operation: "session.transcript.batch",
          elapsedMs: 1_250,
          queueWaitMs: 0,
          writerExecutionMs: 1_250,
          completionDelayMs: 0,
          reentrant: false,
        };
        try {
          const write = runExclusiveSqliteSessionWrite(
            { agentId: "main", env: state.env },
            async () => {
              clock = 1_250;
              if (outcome === "error") {
                throw failure;
              }
              return "written";
            },
            "session.transcript.batch",
          );
          if (outcome === "error") {
            await expect(write).rejects.toBe(failure);
          } else {
            await expect(write).resolves.toBe("written");
          }
          await waitForDiagnosticEventsDrained();
          expect(received).toEqual([
            expect.objectContaining({ message, attributes: expect.objectContaining(fields) }),
          ]);
          await logging.flushLogger();
          const record: unknown = JSON.parse((await fs.readFile(logPath, "utf8")).trim());
          expect(record).toEqual(
            expect.objectContaining({ "1": expect.objectContaining(fields), "2": message }),
          );
        } finally {
          unsubscribe();
          await logging.flushLogger();
          logging.setLoggerOverride(null);
          logging.resetLogger();
          resetDiagnosticEventsForTest();
        }
      },
    );
  },
);

test("captures fast writer failure without error payloads or identities", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const events: unknown[] = [];
    const diagnostics = channel("openclaw.session.write");
    const collect = (event: unknown) => events.push(event);
    const result = { payload: "synthetic-private-writer-result" };
    const failure = new Error("synthetic-private-writer-error");
    diagnostics.subscribe(collect);
    try {
      const write = runExclusiveSqliteSessionWrite(
        { agentId: "synthetic-private-agent", env: state.env },
        async () => {
          clock += 25;
          throw failure;
        },
        "session.transcript.batch",
        { reclamationAdmission: { admissionId: 98123, releaseCause: "worker-release" } },
      );
      await expect(write).rejects.toBe(failure);
      expect(events).toEqual([
        {
          operation: "session.transcript.batch",
          writer: "foreground",
          outcome: "error",
          pid: process.pid,
          threadId,
          isMainThread,
          elapsedMs: 25,
          queueWaitMs: 0,
          writerExecutionMs: 25,
          completionDelayMs: 0,
          reentrant: false,
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("synthetic-private");
      expect(JSON.stringify(events)).not.toContain(state.env.OPENCLAW_STATE_DIR);
    } finally {
      diagnostics.unsubscribe(collect);
    }
    await expect(
      runExclusiveSqliteSessionWrite(
        { agentId: "synthetic-private-agent", env: state.env },
        async () => result,
        "session.transcript.batch",
      ),
    ).resolves.toBe(result);
    expect(events).toHaveLength(1);
  });
});

test("slow writer failure separates waiting and execution", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    let clock = 0;
    const wallStart = Date.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(Date, "now").mockImplementation(() => wallStart + clock);
    const owners = new AsyncLocalStorage<string>();
    const records: Array<{ owner: string | undefined; args: unknown[] }> = [];
    const getChildLogger = logging.getChildLogger;
    vi.spyOn(logging, "getChildLogger").mockImplementation((...args) => {
      const logger = getChildLogger(...args);
      vi.spyOn(logger, "warn").mockImplementation((...values) => {
        records.push({ owner: owners.getStore(), args: values });
        return undefined;
      });
      return logger;
    });
    const scope = { agentId: "main", env: state.env };
    const release = createDeferredCore();
    const order: string[] = [];
    const diagnostics: SqliteSessionReclamationDiagnostics = {};
    const first = owners.run("first", () =>
      runExclusiveSqliteSessionWrite(
        scope,
        async () => {
          order.push("first:start");
          await release.promise;
          Object.assign(diagnostics, {
            kind: "history-eviction",
            workerThreadId: 7,
            payload: "must not enter diagnostics",
          });
          order.push("first:end");
          return "first";
        },
        "session.history.archive-prune",
        diagnostics,
      ),
    );
    expect(order).toEqual(["first:start"]);
    clock = 100;
    const failure = new Error("synthetic writer failure");
    const second = owners.run("second", () =>
      runExclusiveSqliteSessionWrite(
        scope,
        async () => {
          order.push("second:start");
          clock += 400;
          throw failure;
        },
        "session.maintenance.plan",
      ),
    );
    const settled = second.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const queuedSuccessor = owners.run("queued-successor", () =>
      runExclusiveSqliteSessionWrite(
        scope,
        async () => {
          order.push("queued-successor");
          return "queued-successor";
        },
        "session.pending-input.stage",
      ),
    );
    try {
      expect(order).toEqual(["first:start"]);
      clock = 1_600;
      release.resolve();
      expect(await first).toBe("first");
      expect(order).toEqual(["first:start", "first:end"]);
      expect(await settled).toEqual({ error: failure });
      expect(await queuedSuccessor).toBe("queued-successor");
      expect(order).toEqual(["first:start", "first:end", "second:start", "queued-successor"]);
      expect(records.find((entry) => entry.owner === "first")?.args[0]).toHaveProperty(
        "operation",
        "session.history.archive-prune",
      );
      expect(records.find((entry) => entry.owner === "second")?.args[0]).toHaveProperty(
        "operation",
        "session.maintenance.plan",
      );
      expect(records.find((entry) => entry.owner === "queued-successor")?.args[0]).toHaveProperty(
        "operation",
        "session.pending-input.stage",
      );
      expect(records.find((entry) => entry.owner === "first")?.args[0]).toEqual(
        expect.objectContaining({
          pid: process.pid,
          threadId,
          isMainThread,
          reclamationKind: "history-eviction",
          workerThreadId: 7,
          elapsedMs: 1_600,
          queueWaitMs: 0,
          writerExecutionMs: 1_600,
          completionDelayMs: 0,
        }),
      );
      expect(records.find((entry) => entry.owner === "first")?.args[0]).not.toHaveProperty(
        "payload",
      );
      const record = records.find((entry) => entry.owner === "second");
      expect(record?.args[0]).toEqual(
        expect.objectContaining({
          pid: process.pid,
          threadId,
          isMainThread,
          elapsedMs: 1_900,
          queueWaitMs: 1_500,
          writerExecutionMs: 400,
          completionDelayMs: 0,
        }),
      );
      expect(record?.args[0]).not.toHaveProperty("reclamationKind");
      expect(record?.args[0]).not.toHaveProperty("workerThreadId");
      expect(record?.args[0]).toHaveProperty("error", failure.message);
      const warningCount = records.length;
      await expect(
        runExclusiveSqliteSessionWrite(
          scope,
          async () => "successor",
          "session.pending-input.stage",
        ),
      ).resolves.toBe("successor");
      expect(records).toHaveLength(warningCount);
      await runExclusiveSqliteSessionWrite(
        scope,
        () =>
          runExclusiveSqliteSessionWrite(
            scope,
            async () => {
              clock += 1_200;
            },
            "session.pending-input.stage",
            undefined,
            "foreground-reentrant",
          ),
        "session-entry.patch",
      );
      expect(records.slice(warningCount).map((entry) => entry.args[0])).toEqual([
        expect.objectContaining({ operation: "session.pending-input.stage", reentrant: true }),
        expect.objectContaining({ operation: "session-entry.patch", reentrant: false }),
      ]);
      expect(records.some((entry) => entry.args[1] === "slow agent database reservation")).toBe(
        false,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([first, second, queuedSuccessor]);
      vi.restoreAllMocks();
    }
  });
});
