import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as workerCpu from "./worker-cpu.js";

/** Fault only the real import for this exact source; preserve admission messages and SQL. */
export function observeLegacyMcpOAuthImport(
  sourceKey: string,
  mode: "observe" | "post-commit-error" | "native-exit",
) {
  const exit = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  let writerThreadId: number | undefined;
  let importCount = 0;
  let importInputBytes = 0;
  const restore: Array<() => void> = [];
  const preload = `
      import { MessagePort, workerData, threadId } from "node:worker_threads";
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(message, ...args) {
        const result = Reflect.apply(post, this, [message, ...args]);
        if (message?.kind === "native-commit" &&
            message.committed?.facts?.sourceKey === workerData.mcpMigrationSourceKey) {
          const exit = new Int32Array(workerData.mcpMigrationExit);
          Atomics.store(exit, 0, 1);
          Atomics.store(exit, 1, threadId);
          // Forward the real receipt before disrupting this exact command's completion.
          if (workerData.mcpMigrationFaultMode === "native-exit") process.exit(0);
          throw new Error("simulated MCP OAuth result delivery failure");
        }
        return result;
      };
    `;
  const create = workerCpu.createCpuTrackedWorker;
  const created = vi
    .spyOn(workerCpu, "createCpuTrackedWorker")
    .mockImplementation((filename, options) => {
      const worker = create(
        filename,
        mode === "observe"
          ? options
          : {
              ...options,
              execArgv: [
                ...(options?.execArgv ?? []),
                "--import",
                `data:text/javascript,${encodeURIComponent(preload)}`,
              ],
              workerData: {
                ...options?.workerData,
                mcpMigrationSourceKey: sourceKey,
                mcpMigrationFaultMode: mode,
                mcpMigrationExit: exit.buffer,
              },
            },
      );
      const post = worker.postMessage.bind(worker);
      const posted = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
        const message: unknown = args[0];
        if (
          isRecord(message) &&
          message.type === "execute" &&
          message.input instanceof Uint8Array
        ) {
          const command: unknown = deserialize(message.input);
          if (
            isRecord(command) &&
            command.type === "legacyMcpOAuth.import" &&
            isRecord(command.input) &&
            command.input.sourceKey === sourceKey
          ) {
            if (typeof message.id !== "number") {
              throw new Error("Import request has no transport id");
            }
            writerThreadId = worker.threadId;
            importInputBytes = message.input.byteLength;
            importCount++;
          }
        }
        return post(...args);
      });
      restore.push(() => posted.mockRestore());
      return worker;
    });
  restore.push(() => created.mockRestore());

  return {
    importCount: () => importCount,
    injected: () => Atomics.load(exit, 0) === 1,
    importInputBytes: () => importInputBytes,
    writerThreadId: () => writerThreadId,
    exitThreadId: () => Atomics.load(exit, 1),
    restore() {
      for (const undo of restore.toReversed()) {
        undo();
      }
    },
  };
}

/** Calibrate separately, then measure the entire migration with its target database still cold. */
export async function measureMcpMigrationHostSql<T>(run: () => Promise<T>) {
  const { DatabaseSync } = requireNodeSqlite();
  const calibration = new DatabaseSync(":memory:");
  const sql = observeHostDataSql();
  try {
    calibration.prepare("SELECT 1 AS calibration").get();
    expect(sql.queries).toContain("SELECT 1 AS calibration");
    calibration.close();
    sql.queries.length = 0;
    const result = await run();
    return { result, hostQueries: [...sql.queries] };
  } finally {
    sql.restore();
    if (calibration.isOpen) {
      calibration.close();
    }
  }
}
