import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  getOpenClawAgentDatabaseCleanupFailures,
} from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const fault = vi.hoisted(() => ({
  path: "",
  enabled: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
}));
vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (/delete from "agent_database_leases"/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => {
          if (Atomics.load(new Int32Array(workerData.cleanupFaultEnabled), 0)) {
            const selected = prepare.call(this, "SELECT path FROM agent_database_leases WHERE lease_id = ?");
            if (args.some((value) => typeof value === "string" && selected.get(value)?.path === workerData.cleanupFaultPath)) {
              throw new AggregateError([
                Object.assign(new Error("controlled idle worker lease failure; Authorization: Bearer synthetic-cleanup-secret"), { code: "SQLITE_BUSY", errcode: 5 }),
                new Error("controlled lease release refused"),
              ], "Agent database cleanup failed");
            }
          }
          return run(...args);
        };
      }
      return statement;
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: {
          ...options?.workerData,
          cleanupFaultPath: fault.path,
          cleanupFaultEnabled: fault.enabled,
        },
      });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent: () => undefined,
  createAdmission(binding) {
    return () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Cleanup isolation fixture lost admission");
        }
      }),
    });
  },
};

it("keeps other agents usable while a real worker lease cannot close, then recovers its exact owner", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-cleanup-isolation-")) };
  const shared = openOpenClawStateDatabase({ env });
  const first = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
  const second = captureOpenClawAgentDatabaseExecution({ agentId: "second", env });
  const leases = () =>
    shared.db.prepare("SELECT * FROM agent_database_leases WHERE path = ?").all(first.path);
  fault.path = first.path;
  await first.prepare(source);
  const retained = leases();
  expect(retained).toHaveLength(1);
  await first.release();
  Atomics.store(new Int32Array(fault.enabled), 0, 1);
  let retry: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
  try {
    // This must cross the real native-close and retained-lease cleanup boundaries.
    await second.prepare(source);
    expect(await second.runExisting(source, async () => "second remains usable")).toBe(
      "second remains usable",
    );
    expect(leases()).toEqual(retained);
    expect(getOpenClawAgentDatabaseCleanupFailures(shared.path)).toEqual([
      expect.objectContaining({
        agentId: "first",
        reason: expect.stringContaining("controlled idle worker lease failure"),
      }),
    ]);
    const diagnostic = getOpenClawAgentDatabaseCleanupFailures(shared.path)[0]!.reason;
    expect(diagnostic).toContain("SQLITE_BUSY");
    expect(diagnostic).toContain("controlled lease release refused");
    expect(diagnostic).not.toContain("synthetic-cleanup-secret");
    await second.release();

    retry = captureOpenClawAgentDatabaseExecution({ agentId: "first", env });
    const failure: unknown = await retry.prepare(source).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(collectNestedErrorCandidates(failure)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SQLITE_BUSY", errcode: 5 })]),
    );
    expect(formatErrorMessageWithCode(failure)).toContain("controlled idle worker lease failure");
    expect(formatErrorMessageWithCode(failure)).not.toContain("synthetic-cleanup-secret");
    expect(leases()).toEqual(retained);
    Atomics.store(new Int32Array(fault.enabled), 0, 0);
    await retry.prepare(source);
    expect(await retry.runExisting(source, async () => "first recovered")).toBe("first recovered");
    expect(leases()).toHaveLength(1);
    expect(leases()[0]!.lease_id).not.toBe(retained[0]!.lease_id);
    expect(getOpenClawAgentDatabaseCleanupFailures(shared.path)).toEqual([]);
  } finally {
    Atomics.store(new Int32Array(fault.enabled), 0, 0);
    await Promise.all([first.release(), second.release(), retry?.release()]);
  }
});
