import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createOnlineReadOnlyBackup } from "./sqlite-readonly-location.js";
import { readUpdateRunDriver } from "./update-run-driver.js";
import type { InterruptedUpdateGatewayObservation } from "./update-run-interruption-health.js";
import { reconcileInterruptedUpdateRuns } from "./update-run-interruption.js";
import {
  createUpdateRun,
  getUpdateRunAsync,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "./update-run-ledger.js";

const health = vi.hoisted(() => ({
  observe: vi.fn<() => Promise<InterruptedUpdateGatewayObservation>>(),
}));
vi.mock("./update-run-interruption-health.js", () => ({
  observeInterruptedUpdateGateway: health.observe,
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    health.observe.mockReset();
    cleanup();
  }),
);

describe("interrupted update source custody", () => {
  it.each([false, true])(
    "retains its selected database through health observation (replace=%s)",
    async (replace) => {
      const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("interrupted-update-source-") } };
      const driver = readUpdateRunDriver();
      if (!driver) {
        throw new Error("The fixture requires its native process identity");
      }
      const run = createUpdateRun(
        {
          trigger: "cli",
          origin: {
            driver: { ...driver, startIdentity: driver.startIdentity === "0" ? "1" : "0" },
          },
        },
        options,
      );
      const candidate = { version: "2026.9.4", buildId: "source-custody-candidate" };
      recordUpdateRunStep(
        run.runId,
        {
          step: "finalize:installed-candidate",
          status: "completed",
          detail: JSON.stringify(candidate),
        },
        options,
      );
      recordUpdateRunStep(run.runId, { step: "restarting", status: "completed" }, options);
      recordUpdateRunStep(
        run.runId,
        { step: "post-update verification", status: "completed" },
        options,
      );
      recordUpdateRunPhase(run.runId, "verifying", {}, options);
      const before = await getUpdateRunAsync(run.runId, options);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      health.observe.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return {
          outcome: "settled",
          elapsedMs: 1,
          phase: "fixture-health",
          verification: {
            booted: true,
            serviceRunning: true,
            runningVersion: candidate.version,
            runningBuildId: candidate.buildId,
            versionMatch: true,
            readyz: true,
            settled: true,
            channelsReady: true,
            pluginErrors: [],
          },
        };
      });
      const selected = vi.fn();
      const pending = reconcileInterruptedUpdateRuns(options, selected).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      try {
        if (replace) {
          const pathname = resolveOpenClawStateSqlitePath(options.env);
          await closeOpenClawStateDatabaseAsync();
          const snapshot = await createOnlineReadOnlyBackup(
            pathname,
            tempDirs.make("update-source-snapshot-"),
          );
          try {
            const previous = fs.statSync(pathname);
            for (const suffix of ["-wal", "-shm", "-journal"]) {
              if (fs.existsSync(`${pathname}${suffix}`)) {
                fs.renameSync(`${pathname}${suffix}`, `${pathname}.retired${suffix}`);
              }
            }
            fs.copyFileSync(snapshot.location, `${pathname}.replacement`);
            fs.renameSync(`${pathname}.replacement`, pathname);
            expect(fs.statSync(pathname).ino).not.toBe(previous.ino);
          } finally {
            await snapshot.cleanupAsync();
          }
        }
      } finally {
        release.resolve();
      }
      const outcome = await pending;
      if (replace) {
        expect(outcome).toHaveProperty("error");
        expect(
          "error" in outcome && isStateDatabaseReadAdmissionInvalidatedError(outcome.error),
        ).toBe(true);
        expect(await getUpdateRunAsync(run.runId, options)).toEqual(before);
      } else {
        expect(outcome).toMatchObject({ value: [{ runId: run.runId, status: "succeeded" }] });
      }
      expect(selected.mock.calls).toEqual([[run.runId]]);
    },
  );
});
