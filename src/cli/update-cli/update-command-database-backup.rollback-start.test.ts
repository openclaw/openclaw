import { expect, it, vi } from "vitest";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import * as restore from "../../infra/update-database-restore.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { restoreFailedUpdateDatabases } from "./update-command-database-backup.js";

it.each([false, true])(
  "labels a failed rollback by what it touched (touched: %s)",
  async (touched) => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "rollback-start" },
      async (state) => {
        const failure = new Error("database is locked");
        const restored = vi
          .spyOn(restore, "restoreUpdateDatabaseBackup")
          .mockImplementation(async ({ onLiveMutation }) => {
            if (touched) {
              onLiveMutation?.();
            }
            throw failure;
          });
        const result: UpdateRunResult = {
          status: "error",
          mode: "npm",
          steps: [],
          durationMs: 0,
        };
        const rollback = restoreFailedUpdateDatabases({
          backup: { directory: "/backup" } as UpdateDatabaseBackup,
          result,
          runId: "run",
          env: state.env,
          assertCurrent() {},
        });
        try {
          await expect(rollback).rejects.toThrow(
            touched ? "could not finish" : "left the current databases unchanged",
          );
          expect(result.recovery).toMatchObject({
            dataAtRisk: touched ? "rollback-state-unverified" : "state-migrated-no-rollback",
          });
        } finally {
          restored.mockRestore();
        }
      },
    );
  },
);
