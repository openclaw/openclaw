import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { WorkerOptions } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadCronJobsStoreWithConfigJobsReadOnly } from "./store.js";

const injection = vi.hoisted((): { preload?: string } => ({}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        super(filename, {
          ...options,
          execArgv: [
            ...(options?.execArgv ?? []),
            ...(injection.preload && String(filename).includes("/cron/store/read-only.worker.")
              ? ["--import", injection.preload]
              : []),
          ],
        });
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
        const preload = await state.writeText(
          "snapshot-removal-failure.mjs",
          `
import fs from "node:fs";
${failureStage === "copy" ? 'process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? "") + " --import=" + import.meta.url;' : ""}
const remove = fs.rmSync;
fs.rmSync = (target, ...args) => {
  if (String(target).includes("openclaw-sqlite-readonly-")) {
    throw Object.assign(new Error("controlled worker snapshot removal failure"), { code: "EACCES" });
  }
  return remove(target, ...args);
};
`,
        );
        injection.preload = pathToFileURL(preload).href;
        const remove = fsSync.promises.rm;
        let parentRemovalFailed = false;
        const removal = vi
          .spyOn(fsSync.promises, "rm")
          .mockImplementation(async (target, options) => {
            if (
              !parentRemovalFailed &&
              String(target).startsWith(cacheRoot) &&
              String(target).includes("openclaw-sqlite-readonly-")
            ) {
              parentRemovalFailed = true;
              throw Object.assign(new Error("controlled parent snapshot removal failure"), {
                code: "EACCES",
              });
            }
            await remove(target, options);
          });
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
          expect((await remaining()).length).toBeGreaterThan(0);
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
          expect(await remaining()).toEqual([]);
          expect(parentRemovalFailed).toBe(true);
        } finally {
          removal.mockRestore();
          injection.preload = undefined;
        }
      },
    );
  },
);
