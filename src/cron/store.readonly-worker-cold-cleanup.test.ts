import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkerOptions } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "./store.js";
import { installCronSnapshotFaults } from "./store.readonly-worker-faults.test-support.js";

const injection = vi.hoisted(
  (): { preload?: string; workerUrl?: string; observe?: (message: unknown) => void } => ({}),
);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        const selected = String(filename) === injection.workerUrl;
        super(filename, {
          ...options,
          execArgv: [
            ...(options?.execArgv ?? []),
            ...(injection.preload && selected ? ["--import", injection.preload] : []),
          ],
        });
        if (selected) {
          this.on("message", (message: unknown) => injection.observe?.(message));
        }
      }
    },
  };
});

it.each(["read", "copy"] as const)(
  "retains cold snapshot cleanup after a worker %s failure",
  async (failureStage) => {
    await withOpenClawTestState(
      { label: "cron-cold-cleanup", env: { XDG_CACHE_HOME: undefined } },
      async (state) => {
        const cacheRoot = state.statePath("snapshot-cache");
        process.env.XDG_CACHE_HOME = cacheRoot;
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        const db = new DatabaseSync(databasePath);
        db.exec("CREATE TABLE marker(value TEXT)");
        db.close();
        const originalBytes = await fs.readFile(databasePath);
        const fault = await installCronSnapshotFaults(state, failureStage);
        injection.preload = fault.cronPreload;
        injection.workerUrl = fault.cronWorkerUrl;
        const originalFailure =
          failureStage === "read"
            ? "controlled cron read query failure"
            : "controlled worker snapshot copy failure";
        let originalFailureObserved = false;
        injection.observe = (message) => {
          if (
            isRecord(message) &&
            message.status === "ok" &&
            isRecord(message.value) &&
            message.value.ok === false &&
            isRecord(message.value.error) &&
            typeof message.value.error.message === "string"
          ) {
            originalFailureObserved ||= message.value.error.message.includes(originalFailure);
          }
        };
        const remaining = async () =>
          (await fs.readdir(cacheRoot, { recursive: true })).filter((name) =>
            name.includes("openclaw-sqlite-readonly-"),
          );
        try {
          await expect(
            withArtifactPreservingStateReads(() =>
              loadCronJobsStoreWithConfigJobsReadOnly(
                state.statePath("cron", "jobs.json"),
                state.env,
              ),
            ),
          ).rejects.toThrow("cleanup failed");
          expect(originalFailureObserved).toBe(true);
          expect(fault.count(failureStage === "read" ? "read-query" : "copy-open")).toBeGreaterThan(
            0,
          );
          expect(fault.count("staging-rm")).toBeGreaterThan(0);
          expect(await fs.readFile(databasePath)).toEqual(originalBytes);
          expect((await remaining()).length).toBeGreaterThan(0);
          await closeOpenClawStateDatabaseByPathAsync(state.statePath("unrelated.sqlite"));
          expect((await remaining()).length).toBeGreaterThan(0);
          fault.allowRemoval();
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
          expect(await remaining()).toEqual([]);
          expect(await fs.readFile(databasePath)).toEqual(originalBytes);
        } finally {
          fault.allowRemoval();
          try {
            await closeOpenClawStateDatabaseByPathAsync(databasePath);
          } finally {
            fault.restore();
            injection.preload = undefined;
            injection.workerUrl = undefined;
            injection.observe = undefined;
          }
        }
      },
    );
  },
);
