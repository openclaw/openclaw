import "./doctor-maintenance.settlement.test-support.js";
import { expect, it, vi } from "vitest";
import * as capture from "../infra/update-recovery-baseline-capture.js";
import * as driver from "../infra/update-run-driver.js";
import { preparePluginDoctorMigrationResources } from "../plugins/doctor-migration-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { preserveDoctorOriginalState } from "./doctor-original-capture.js";

const { boundary, root } = await import("./doctor-maintenance.settlement.test-support.js");

it.each(["timeout", "failure", "fast"] as const)(
  "settles pre-repair capture and restores the stopped service: %s",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = createDeferredCore();
    const inventory = createDeferredCore<[]>();
    vi.spyOn(driver, "readUpdateRunDriver").mockReturnValue({
      host: "synthetic-host",
      pid: process.pid,
      startIdentity: "1",
    });
    vi.spyOn(capture, "captureUpdateRecoveryBaseline").mockImplementation(
      async ({ signal, env }) => {
        entered.resolve();
        if (mode === "failure") {
          throw new Error("synthetic backup disk full");
        }
        await preparePluginDoctorMigrationResources(
          [
            {
              pluginId: "fixture-plugin",
              migration: {
                id: "fixture-migration",
                label: "Fixture migration",
                collectBackupResources: () => (mode === "timeout" ? inventory.promise : []),
                detectLegacyState: () => null,
                migrateLegacyState: () => {
                  throw new Error("Repair must not run during capture");
                },
              },
            },
          ],
          { config: {}, env, stateDir: "/synthetic/doctor-state", warnings: [], signal },
        );
        return {
          ref: {
            directory: "/synthetic/capture",
            manifestPath: "/synthetic/capture/manifest.json",
            manifestSha256: "0".repeat(64),
          },
          warnings: [],
          diagnostics: { databaseWarnings: [] },
        };
      },
    );
    let outcome: unknown;
    const work = beginDoctorMaintenance({
      root,
      options: { repair: true, nonInteractive: true },
      runtime: { log: boundary.log, error: vi.fn(), exit: vi.fn() },
      beforeStateMutation: async ({ env, signal }) => {
        await preserveDoctorOriginalState({
          root,
          env,
          signal,
          assertCurrent() {},
          runtime: { log: boundary.log, error: vi.fn(), exit: vi.fn() },
        });
      },
    }).then(
      (value) => {
        outcome = value;
        return value;
      },
      (error: unknown) => {
        outcome = error;
        return undefined;
      },
    );
    try {
      await entered.promise;
      if (mode === "timeout") {
        await vi.advanceTimersByTimeAsync(600_000);
      }
      await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 1_000 });
      if (mode === "fast") {
        expect(outcome).not.toBeInstanceOf(Error);
        expect(boundary.restart).not.toHaveBeenCalled();
        await (await work)!.finish({});
      } else {
        expect(outcome).toMatchObject({
          message: expect.stringContaining("State repair has not started"),
        });
        expect(String(outcome)).toContain(
          mode === "timeout" ? "fixture-plugin/fixture-migration" : "synthetic backup disk full",
        );
        expect(String(outcome)).toContain("openclaw doctor --fix");
      }
      expect(boundary.resume).toHaveBeenCalledWith(true);
      expect(boundary.complete).toHaveBeenCalledWith(true);
      expect(boundary.restart).toHaveBeenCalledOnce();
      expect(boundary.health).toHaveBeenCalledOnce();
    } finally {
      inventory.resolve([]);
      await (await work)?.release();
      vi.useRealTimers();
    }
  },
);
