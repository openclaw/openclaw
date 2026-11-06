import { expect, it, vi } from "vitest";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import * as workers from "../infra/worker-cpu.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { installCronSnapshotFaults } from "./store.readonly-worker-faults.test-support.js";
import { withCronStore } from "./store.worker.test-support.js";
import { resolveCronStoreKeyAsync } from "./store/paths.js";

it.each(["read", "copy"] as const)(
  "retains the worker %s failure and cold snapshot cleanup custody",
  async (failureStage) => {
    await withCronStore(
      "cron-cold-cleanup",
      async (state) => {
        const cacheRoot = state.statePath("snapshot-cache");
        process.env.XDG_CACHE_HOME = cacheRoot;
        await state.createDatabase();
        // Selection uses another worker; keep the cron reader cold for these faults.
        await resolveCronStoreKeyAsync(state.storePath, state.env);
        const originalBytes = await state.bytes();
        const fault = await installCronSnapshotFaults(state, failureStage);
        const originalFailure =
          failureStage === "read"
            ? "controlled cron read query failure"
            : "controlled worker snapshot copy failure";
        const observe = vi.fn();
        const create = workers.createCpuTrackedWorker;
        const injection = vi
          .spyOn(workers, "createCpuTrackedWorker")
          .mockImplementation((url, options) => {
            if (String(url) !== fault.cronWorkerUrl) {
              return create(url, options);
            }
            const worker = create(url, {
              ...options,
              execArgv: [...(options?.execArgv ?? []), "--import", fault.cronPreload!],
            });
            worker.on("message", observe);
            return worker;
          });
        const failure = expect.objectContaining({
          message: expect.stringContaining(originalFailure),
        });
        const remaining = async () =>
          (await listDirectoryTreeStrict(cacheRoot))
            .map((walkEntry) => walkEntry.relativePath)
            .filter((name) => name.includes("openclaw-sqlite-readonly-"));
        try {
          await expect(state.read(true)).rejects.toMatchObject({
            errors: [
              failure,
              expect.objectContaining({ message: "Cron read-only state snapshot cleanup failed." }),
            ],
            cause: failure,
          });
          expect(observe).toHaveBeenCalledWith(
            expect.objectContaining({
              status: "ok",
              value: expect.objectContaining({ ok: false, error: failure }),
            }),
          );
          expect(fault.count(failureStage === "read" ? "read-query" : "copy-open")).toBeGreaterThan(
            0,
          );
          expect(fault.count("staging-rm")).toBeGreaterThan(0);
          expect(await state.bytes()).toEqual(originalBytes);
          expect((await remaining()).length).toBeGreaterThan(0);
          await closeOpenClawStateDatabaseByPathAsync(state.statePath("unrelated.sqlite"));
          expect((await remaining()).length).toBeGreaterThan(0);
          fault.allowRemoval();
          await state.close();
          expect(await remaining()).toEqual([]);
          expect(await state.bytes()).toEqual(originalBytes);
        } finally {
          fault.allowRemoval();
          try {
            await state.close();
          } finally {
            fault.restore();
            injection.mockRestore();
          }
        }
      },
      { XDG_CACHE_HOME: undefined },
    );
  },
);
