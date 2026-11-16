import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as activatedGateway from "../../infra/update-activated-gateway-check.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import { readUpdateDatabaseGenerations } from "../../infra/update-database-generations.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../../infra/update-doctor-result.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { settleMutableUpdateResult } from "./update-command-execution-settlement.js";
import {
  bindExecutionGuards,
  executionParams,
  successfulUpdate,
} from "./update-command-execution.test-support.js";

it.each([false, true])(
  "retains successful boot writes without adopting prior foreign writes: %s",
  async (foreign) => {
    await withOpenClawTestState({ scenario: "minimal", applyEnv: true }, async ({ env }) => {
      const pathname = path.join(env.OPENCLAW_STATE_DIR!, "boot.sqlite");
      const write = (value: number) => {
        using db = new DatabaseSync(pathname);
        db.exec("CREATE TABLE IF NOT EXISTS retained(value); DELETE FROM retained");
        db.prepare("INSERT INTO retained VALUES (?)").run(value);
      };
      write(7);
      const generations = readUpdateDatabaseGenerations([pathname]);
      const backup: UpdateDatabaseBackup = {
        directory: path.dirname(pathname),
        databases: [
          {
            path: pathname,
            snapshotPath: pathname,
            userVersion: 0,
            sha256: "0".repeat(64),
            sizeBytes: 0,
          },
        ],
        sourcePaths: [pathname],
        missingPaths: [],
        sourceGenerations: generations,
        warnings: [],
        migration: { name: "Doctor", backup: pathname, from: generations, to: generations },
      };
      if (foreign) {
        write(8);
      }
      const boot = vi
        .spyOn(activatedGateway, "checkActivatedGatewayStartup")
        .mockImplementation(async ({ result }) => {
          write(9);
          return result;
        });
      const params = await bindExecutionGuards({
        ...executionParams("package"),
        shouldRestart: false,
        opts: { json: true, restart: false, run: { runId: "boot-regression", env } },
      });
      const result = await settleMutableUpdateResult(params, {
        result: { ...successfulUpdate, steps: [] },
        failure: undefined,
        databaseBackup: backup,
        activationSteps: [],
        doctorEntered: true,
        originalRun: params.opts.run,
        env,
        assertCurrent() {},
      });
      expect(result.status).toBe("ok");
      expect(boot).toHaveBeenCalledOnce();
      const current = readUpdateDatabaseGenerations([pathname]);
      expect(current).not.toEqual(generations);
      expect(backup.migration!.to).toEqual(foreign ? generations : current);
      const capture = createUpdateDoctorDatabaseWriteCapture(backup.migration!.to, {
        env,
        signal: new AbortController().signal,
        warn: vi.fn(),
      })!;
      await capture.admit();
      await capture.settle();
      expect(capture.receipt?.unchanged).toBe(!foreign);
    });
  },
);
