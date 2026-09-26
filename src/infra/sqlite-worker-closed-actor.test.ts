import path from "node:path";
import { serialize } from "node:v8";
import { MessageChannel, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SqliteWorkerReply, SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import {
  acquireStateDatabaseCoordinator,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(Boolean(process.versions.bun))(
  "releases state-lifecycle when the commanded actor is already closed",
  async () => {
    const root = dirs.make("sqlite-worker-closed-actor-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const runtimeDirectory = path.join(root, "runtime");
    const worker = new Worker(new URL("./sqlite-store.worker.ts", import.meta.url), {
      execArgv: ["--import", import.meta.resolve("tsx/esm")],
    });
    const { port1: preparation, port2: workerPreparation } = new MessageChannel();
    const replied = new Promise<SqliteWorkerReply>((resolve, reject) => {
      // The worker answers on the preparation port once it owns the lifecycle.
      preparation.on("message", (message: unknown) => {
        if (!isRecord(message)) {
          return;
        }
        if (message.type === "check" || message.type === "acquired") {
          // No borrowed lifecycle: the worker must acquire the coordinator itself.
          preparation.postMessage({ type: "accepted" }, []);
        } else if (message.type === "result") {
          // SAFETY: The worker relays its typed reply through the preparation port.
          resolve(message.reply as SqliteWorkerReply);
        }
      });
      worker.on("message", (reply: SqliteWorkerReply) => resolve(reply));
      worker.on("error", reject);
      worker.on("exit", (code) => reject(new Error(`SQLite worker exited with code ${code}`)));
    });
    const request: SqliteWorkerRequest = {
      id: 1,
      actor: 1,
      type: "execute",
      input: serialize({ type: "append", input: { value: "closed" } }),
      stateContext: {
        environment: { OPENCLAW_STATE_DIR: root },
        coordinatorRuntime: { directory: runtimeDirectory, keepAlive: false },
      },
      stateDatabasePath: databasePath,
      workerStateLifecycle: { deadlineNs: process.hrtime.bigint() + 10_000_000_000n },
      lifecyclePreparation: workerPreparation,
    };
    try {
      worker.postMessage(request, [workerPreparation]);
      const reply = await replied;
      expect(reply).toMatchObject({
        ok: false,
        error: { message: "SQLite worker actor is closed" },
      });
      // The broker keeps this worker alive, so custody must already be gone.
      expect("retire" in reply).toBe(false);
      const coordinator = withStateDatabaseCoordinatorRuntimeDirectory(
        { directory: runtimeDirectory, keepAlive: false },
        () => acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 }),
      );
      coordinator.release();
    } finally {
      preparation.close();
      await worker.terminate();
    }
  },
  30_000,
);
