import fs from "node:fs";
import path from "node:path";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import * as snapshotWorker from "../infra/sqlite-readonly-worker.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { withOpenClawStateDatabaseReadSnapshot } from "./openclaw-state-db-readonly.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("lets Doctor cancel a pending lazy schema snapshot without blocking signal delivery", async () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("doctor-lazy-cancellation-") };
  const pathname = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname));
  fs.writeFileSync(pathname, "pending inspection source");
  const controller = new AbortController();
  const cancelled = new Error("Doctor interrupted by SIGTERM");
  // Bound the broken synchronous path so this regression fails instead of hanging.
  vi.spyOn(snapshotWorker, "readSqliteInspectionBudget").mockReturnValue({
    timeoutMs: 10,
    size: "fixture",
  });
  const closed = vi.fn();
  vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync").mockImplementation(() => {
    const retained = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
    controller.signal.addEventListener("abort", () => retained.reject(cancelled), { once: true });
    queueMicrotask(() => controller.abort(cancelled));
    return {
      ...retained.operation,
      startClose() {
        closed();
        const close = createRetainedOperation<void>(() => {});
        close.resolve(undefined);
        return close.operation;
      },
    };
  });
  await expect(
    withOpenClawStateDatabaseReadSnapshot(
      () => preflightOpenClawDatabaseSchemas({ env, scope: "state", signal: controller.signal }),
      { env, lazy: true, signal: controller.signal },
    ),
  ).rejects.toBe(cancelled);
  expect(closed).toHaveBeenCalledOnce();
});
