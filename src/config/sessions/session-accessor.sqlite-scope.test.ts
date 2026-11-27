import assert from "node:assert/strict";
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

function timing(elapsedMs: number, queueWaitMs = 0, writerExecutionMs = elapsedMs - queueWaitMs) {
  return {
    pid: process.pid,
    threadId,
    isMainThread,
    elapsedMs,
    queueWaitMs,
    writerExecutionMs,
    completionDelayMs: 0,
    reentrant: false,
  };
}

function writer(env: NodeJS.ProcessEnv, agentId = "main") {
  return <T>(
    run: () => Promise<T>,
    operation: Parameters<typeof runExclusiveSqliteSessionWrite>[2] = "session.transcript.batch",
    diagnostics?: SqliteSessionWriteDiagnostics,
    kind?: "foreground-reentrant",
  ) => runExclusiveSqliteSessionWrite({ agentId, env }, run, operation, diagnostics, kind);
}

async function withFileLog(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  return withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
    async (state) => {
      const logPath = state.path("sqlite-write.log");
      logging.setLoggerOverride({ level: "warn", file: logPath });
      try {
        await run(state.env);
        await logging.flushLogger();
        const content = await fs.readFile(logPath, "utf8");
        const record: unknown = JSON.parse(content.trim());
        assert.ok(isRecord(record));
        return { content, record };
      } finally {
        await logging.flushLogger();
        logging.resetLogger();
      }
    },
  );
}

test.each([undefined, "agent:main:dashboard:incognito-root"])(
  "keeps an explicit incognito root outside the ambient root (key: %s)",
  async (sessionKey) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const root = state.path("captured-root");
      const storePath = path.join(root, "agents/main/agent/incognito-openclaw-agent.sqlite");
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
  const operation = diagnostics?.artifactPreparation
    ? "session.lifecycle.artifacts-prepare"
    : "session.transcript.batch";
  const { content, record } = await withFileLog(async (env) => {
    await expect(
      writer(env)(
        async () => {
          throw failure;
        },
        operation,
        diagnostics,
      ),
    ).rejects.toBe(failure);
  });
  const details = record["1"];
  assert.ok(isRecord(details));
  expect(record["2"]).toBe("SQLite session write failed");
  expect(details.operation).toBe(operation);
  return { content, error: details.error, details };
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
      worker.once("error", resolve);
      worker.once("exit", () =>
        reject(new Error("Synthetic worker exited without its expected error")),
      );
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
  const expected = {
    nodeRows: 8,
    windowRows: 12,
    referenceIds: 8,
    selectedEntries: 0,
    markerWindows: 2,
    markerRows: 5,
    completed: false,
    admissionMode: "async" as const,
    admissionMs: 1200,
    nodeInventoryMs: 21,
    referencePlanningMs: 4,
    orphanPlanningMs: 5,
    markerScanMs: 20,
  };
  const artifactPreparation: SqliteSessionArtifactPreparationDiagnostics = {
    ...expected,
    admissionMs: 1200.4,
    nodeInventoryMs: 20.6,
    referencePlanningMs: 4.2,
    orphanPlanningMs: 5.1,
    markerScanMs: 19.6,
  };
  Object.assign(artifactPreparation, {
    sessionId: "synthetic-private-session",
    marker: "synthetic-private-marker",
  });
  const record = await readFailedWriterLog(new Error("synthetic planning failure"), {
    artifactPreparation,
  });
  expect(record.details.artifactPreparation).toEqual(expected);
  expect(record.content).not.toContain("synthetic-private-session");
  expect(record.content).not.toContain("synthetic-private-marker");
});

test("archive pruning file logs whitelist partial stage observations", async () => {
  const expected = {
    trigger: "initial" as const,
    checkpointCalls: 2,
    checkpointIncomplete: 1,
    checkpointMs: 21,
    checkpointMaxMs: 20,
    completed: false,
  };
  const archivePruning = {
    ...expected,
    checkpointMs: 20.6,
    checkpointMaxMs: 19.6,
    archiveName: "synthetic-private-archive",
    content: "synthetic-private-transcript",
  };
  const { content, record } = await withFileLog(async () => {
    const failure = new Error("synthetic pruning failure");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    await expect(
      observeSessionArchivePruning(archivePruning, async () => {
        clock = 1200.4;
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
  const details = record["2"];
  assert.ok(isRecord(details));
  expect(record["1"]).toBe("SQLite session archive pruning failed");
  expect(details).toHaveProperty("elapsedMs", 1200);
  expect(details).not.toHaveProperty("queueWaitMs");
  expect(details).not.toHaveProperty("writerExecutionMs");
  expect(details.archivePruning).toEqual(expected);
  expect(content).not.toContain("synthetic-private-archive");
  expect(content).not.toContain("synthetic-private-transcript");
});

test.each(["ok", "error"] as const)(
  "retains session writer timing in diagnostic events and file metadata (%s)",
  async (outcome) => {
    logging.resetLogger();
    const received: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    let unsubscribe = () => {};
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const failure = new Error("synthetic writer failure");
    const message = outcome === "ok" ? "slow SQLite session write" : "SQLite session write failed";
    const fields = { operation: "session.transcript.batch", ...timing(1_250) };
    try {
      const { record } = await withFileLog(async (env) => {
        resetDiagnosticEventsForTest();
        unsubscribe = onInternalDiagnosticEvent((event) => {
          if (event.type === "log.record") {
            received.push(event);
          }
        });
        const write = writer(env)(async () => {
          clock = 1_250;
          if (outcome === "error") {
            throw failure;
          }
          return "written";
        });
        if (outcome === "error") {
          await expect(write).rejects.toBe(failure);
        } else {
          await expect(write).resolves.toBe("written");
        }
        await waitForDiagnosticEventsDrained();
        expect(received).toEqual([
          expect.objectContaining({ message, attributes: expect.objectContaining(fields) }),
        ]);
      });
      expect(record).toMatchObject({ "1": fields, "2": message });
    } finally {
      unsubscribe();
      logging.setLoggerOverride(null);
      resetDiagnosticEventsForTest();
    }
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
    const write = writer(state.env, "synthetic-private-agent");
    diagnostics.subscribe(collect);
    try {
      const pending = write(
        async () => {
          clock += 25;
          throw failure;
        },
        "session.transcript.batch",
        { reclamationAdmission: { admissionId: 98123, releaseCause: "worker-release" } },
      );
      await expect(pending).rejects.toBe(failure);
      expect(events).toEqual([
        {
          operation: "session.transcript.batch",
          writer: "foreground",
          outcome: "error",
          ...timing(25),
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("synthetic-private");
      expect(JSON.stringify(events)).not.toContain(state.env.OPENCLAW_STATE_DIR);
    } finally {
      diagnostics.unsubscribe(collect);
    }
    await expect(write(async () => result)).resolves.toBe(result);
    expect(events).toHaveLength(1);
  });
});

test("slow writer failure separates waiting and execution", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    let clock = 0;
    const wallStart = Date.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(Date, "now").mockImplementation(() => wallStart + clock);
    const records: unknown[][] = [];
    const fieldsFor = (operation: string) =>
      records.find(([fields]) => isRecord(fields) && fields.operation === operation)?.[0];
    const getChildLogger = logging.getChildLogger;
    vi.spyOn(logging, "getChildLogger").mockImplementation((...args) => {
      const logger = getChildLogger(...args);
      vi.spyOn(logger, "warn").mockImplementation((...values) => {
        records.push(values);
        return undefined;
      });
      return logger;
    });
    const write = writer(state.env);
    const release = createDeferredCore();
    const entered = createDeferredCore();
    const releaseSecond = createDeferredCore();
    const order: string[] = [];
    const diagnostics: SqliteSessionReclamationDiagnostics = {};
    const first = write(
      async () => {
        order.push("first:start");
        entered.resolve();
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
    );
    let second: Promise<never> | undefined;
    let queuedSuccessor: Promise<string> | undefined;
    try {
      await Promise.race([entered.promise, first]);
      expect(order).toEqual(["first:start"]);
      clock = 100;
      const failure = new Error("synthetic writer failure");
      second = write(async () => {
        order.push("second:start");
        await releaseSecond.promise;
        clock += 400;
        throw failure;
      }, "session.maintenance.plan");
      const settled = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      queuedSuccessor = write(async () => {
        order.push("queued-successor");
        return "queued-successor";
      }, "session.pending-input.stage");
      expect(order).toEqual(["first:start"]);
      clock = 1_600;
      release.resolve();
      expect(await first).toBe("first");
      releaseSecond.resolve();
      expect(await settled).toEqual({ error: failure });
      expect(await queuedSuccessor).toBe("queued-successor");
      expect(order).toEqual(["first:start", "first:end", "second:start", "queued-successor"]);
      expect(fieldsFor("session.pending-input.stage")).toHaveProperty(
        "operation",
        "session.pending-input.stage",
      );
      expect(fieldsFor("session.history.archive-prune")).toMatchObject({
        ...timing(1_600),
        operation: "session.history.archive-prune",
        reclamationKind: "history-eviction",
        workerThreadId: 7,
      });
      expect(fieldsFor("session.history.archive-prune")).not.toHaveProperty("payload");
      expect(fieldsFor("session.pending-input.stage")).toHaveProperty("holderAtEnqueue", {
        operation: "session.history.archive-prune",
        threadId,
        heldMs: 100,
      });
      const record = fieldsFor("session.maintenance.plan");
      expect(record).toMatchObject({
        ...timing(1_900, 1_500, 400),
        operation: "session.maintenance.plan",
        holderAtEnqueue: {
          operation: "session.history.archive-prune",
          threadId,
          heldMs: 100,
        },
        error: failure.message,
      });
      expect(record).not.toHaveProperty("reclamationKind");
      expect(record).not.toHaveProperty("workerThreadId");
      const warningCount = records.length;
      await expect(write(async () => "successor", "session.pending-input.stage")).resolves.toBe(
        "successor",
      );
      expect(records).toHaveLength(warningCount);
      await write(
        () =>
          write(
            async () => {
              clock += 1_200;
            },
            "session.pending-input.stage",
            undefined,
            "foreground-reentrant",
          ),
        "session-entry.patch",
      );
      expect(records.slice(warningCount).map(([fields]) => fields)).toEqual([
        expect.objectContaining({ operation: "session.pending-input.stage", reentrant: true }),
        expect.objectContaining({ operation: "session-entry.patch", reentrant: false }),
      ]);
      expect(records.some(([, message]) => message === "slow agent database reservation")).toBe(
        false,
      );
    } finally {
      release.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, second, queuedSuccessor]);
      vi.restoreAllMocks();
    }
  });
});
