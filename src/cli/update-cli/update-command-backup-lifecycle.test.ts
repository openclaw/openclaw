import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { tryAcquireExclusiveSqliteCoordinator } from "../../infra/sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  completeUpdateCommandBackup,
  createUpdateCommandBackup,
} from "./update-command-backup-lifecycle.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  deferUpdateCommandTerminalResult,
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";

afterEach(() => vi.restoreAllMocks());

it.each(["healthy", "readiness-missing", "wrong-version", "settlement-failed"] as const)(
  "retires only the settled, identity-verified capture: %s",
  async (scenario) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const temporary = state.path("coordinator");
      await fs.mkdir(temporary, { mode: 0o700 });
      vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const outputs: unknown[] = [];
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
        outputs.push(value);
      });
      const root = state.path("install");
      await fs.mkdir(root);
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
        env: state.env,
      };
      const opts = { json: true, run };
      const result: UpdateRunResult = {
        status: "ok",
        mode: "npm",
        root,
        before: { version: "2026.9.3" },
        after: { version: "2026.9.4", buildId: "candidate-build" },
        steps: [],
        durationMs: 1,
      };
      let capturePath = "";
      const execution = withUpdateCommandTerminalResult(run, () =>
        withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(root);
          const backup = await createUpdateCommandBackup({ opts, root, env: state.env });
          capturePath = backup.directory;
          recordUpdateRunVerification(
            run.runId,
            {
              serviceRunning: true,
              versionMatch: true,
              runningVersion: scenario === "wrong-version" ? "2026.9.3" : "2026.9.4",
              runningBuildId: "candidate-build",
              readyz: scenario !== "readiness-missing",
              settled: true,
              channelsReady: true,
              pluginErrors: [],
            },
            { env: state.env },
          );
          recordUpdateRunStep(
            run.runId,
            {
              step: "gateway verification",
              status: "completed",
              endedAtMs: Date.now(),
            },
            { env: state.env },
          );
          deferUpdateCommandTerminalResult(run, async (failure) => {
            const settled = await resolveSettledUpdateCommandResult(
              { opts, root },
              result,
              failure,
            );
            return await publishUpdateCommandTerminalResult({ opts }, settled.result, {
              rolledBack: false,
            });
          });
          await completeUpdateCommandBackup(
            { opts, root, updateRecoveryBackup: backup },
            result,
            () => run.executorFence!.assertCurrent(),
          );
          // A published package and healthy Gateway cannot retire recovery while
          // the mutating invocation still owns its lifetime.
          expect((await fs.stat(capturePath)).isDirectory()).toBe(true);
          if (scenario === "settlement-failed") {
            const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
            try {
              db.exec(
                "CREATE TRIGGER refuse_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture release failure'); END",
              );
            } finally {
              db.close();
            }
          }
        }),
      );
      if (scenario === "settlement-failed") {
        await expect(execution).rejects.toThrow();
      } else {
        await execution;
      }
      const retained = await fs.stat(capturePath).then(
        () => true,
        () => false,
      );
      expect(retained).toBe(scenario !== "healthy");
      expect(outputs).toHaveLength(1);
      expect(getUpdateRun(run.runId, { env: state.env })?.status).toBe(
        scenario === "settlement-failed" ? "failed" : "succeeded",
      );
      if (retained) {
        expect(
          await fs.readFile(path.join(capturePath, "outcome.json"), "utf8").catch(() => null),
        ).toBeNull();
      }
    });
  },
);

it.each([false, true])(
  "captures only after physical writer quiescence (external writer=%s)",
  async (active) => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        scenario: "minimal",
        env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external" },
      },
      async (state) => {
        await state.writeConfig({ plugins: { enabled: false } });
        const temporary = state.path("coordinator");
        await fs.mkdir(temporary, { mode: 0o700 });
        vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
        const root = state.path("install");
        await fs.mkdir(root);
        const run: NonNullable<UpdateCommandOptions["run"]> = {
          runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
          env: state.env,
        };
        const anchor = acquireGatewayLifecycleCoordinator({
          databasePath: resolveOpenClawStateSqlitePath(state.env),
        });
        anchor.release();
        const writer = active
          ? tryAcquireExclusiveSqliteCoordinator(anchor.path, { busyTimeoutMs: 0 })
          : null;
        if (active) {
          expect(writer).not.toBeNull();
        }
        const before = await fs.readFile(state.configPath);
        try {
          await withUpdateCommandExecutor(run.runId, async (executor) => {
            run.executorFence = await executor.enter(root);
            const capture = createUpdateCommandBackup({ opts: { run }, root, env: state.env });
            if (active) {
              await expect(capture).rejects.toThrow(
                "another OpenClaw process owns gateway-lifecycle",
              );
              await expect(fs.lstat(`${state.stateDir}.update-captures`)).rejects.toMatchObject({
                code: "ENOENT",
              });
              expect(
                getUpdateRun(run.runId, { env: state.env })?.steps.some(
                  (step) => step.step === "update recovery backup",
                ),
              ).toBe(false);
            } else {
              const backup = await capture;
              expect((await fs.stat(backup.manifestPath)).isFile()).toBe(true);
            }
          });
          expect(await fs.readFile(state.configPath)).toEqual(before);
        } finally {
          writer?.release();
        }
      },
    );
  },
);
