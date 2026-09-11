import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as convergence from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import { createUpdateRecoveryBackup } from "../../infra/update-recovery-backup.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexRowSync } from "../../plugins/installed-plugin-index-row.js";
import { spawnCommand } from "../../process/exec-spawn.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { killPidIfAlive, waitForPidToExit } from "../../test-utils/process-tree.js";
import { VERSION } from "../../version.js";
import * as configPreparation from "./update-command-config.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import * as pluginUpdater from "./update-command-plugins.js";
import * as postCoreOwner from "./update-command-post-core.js";
import { finishUpdate, type FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import * as rollbackOwner from "./update-command-rollback.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const transport = vi.hoisted(() => ({ exec: vi.fn(), command: vi.fn() }));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: transport.exec,
  runCommandWithTimeout: transport.command,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connected in-process plugin finalization authority", () => {
  it.each([
    "healthy",
    "index-revoked",
    "config-revoked",
    "run-replaced",
    "fence-replaced",
  ] as const)("protects persistence and terminal behavior with %s", async (scenario) => {
    await withOpenClawTestState(
      {
        label: `plugin-caller-${scenario}`,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_UPDATE_RUN_HANDOFF: undefined },
      },
      async (state) => {
        const control = state.path("control");
        const otherRoot = state.path("other-install");
        await fs.mkdir(control);
        await fs.mkdir(otherRoot);
        await fs.mkdir(state.path("dist"));
        await fs.writeFile(state.path("dist", "entry.js"), "// Inert transport fixture.\n");
        await fs.writeFile(
          state.path("package.json"),
          JSON.stringify({ name: "openclaw", version: VERSION }),
        );
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
        const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
        let assertOriginalCurrent: (() => void) | undefined;
        let runAtPublication: ReturnType<typeof getUpdateRun>;
        const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {
          // The CLI terminal owner publishes only after the real executor closes.
          expect(assertOriginalCurrent).toBeDefined();
          expect(assertOriginalCurrent).toThrow();
          runAtPublication = getUpdateRun(created.runId, { env: state.env });
        });
        transport.command
          .mockReset()
          .mockRejectedValue(new Error("Unexpected package/native command"));
        transport.exec.mockReset().mockImplementation(async (_file, args: string[]) => {
          if (args[0] !== state.path("dist", "entry.js")) {
            throw new Error("Unexpected external entrypoint");
          }
          if (args[1] === "doctor" || (args[1] === "config" && args[2] === "validate")) {
            return { stdout: JSON.stringify({ ok: true, checksRun: 1, findings: [] }), stderr: "" };
          }
          throw new Error("Unexpected external command");
        });

        // Restore an authored setting dropped during core update. Both snapshots are real;
        // this forces the plugin commit without a package fetch or fake convergence result.
        const authoredChannels = { telegram: { enabled: false } };
        await state.writeConfig({ plugins: { enabled: false }, channels: authoredChannels });
        const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
        const currentConfig = { plugins: { enabled: false } };
        await state.writeConfig(currentConfig);
        await writePersistedInstalledPluginIndexInstallRecords(
          {},
          { config: currentConfig, env: state.env },
        );
        const originalConfig = await fs.readFile(state.configPath, "utf8");
        const diagnosticPath = await state.writeText(
          "retained-diagnostic.json",
          "retained diagnostic\n",
        );
        const metaPath = await state.writeJson("sentinel-meta.json", {
          version: 1,
          meta: { triageContextPath: diagnosticPath },
        });
        const targetEnv = {
          ...state.env,
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
        };
        const created = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const readIndex = () => readPersistedInstalledPluginIndexRowSync({ env: state.env });
        let indexAtConvergence: ReturnType<typeof readIndex>;
        let runAtConvergence: ReturnType<typeof getUpdateRun>;
        let configBoundaryReached = false;
        let refused: unknown;
        let completed: Awaited<ReturnType<typeof finishUpdate>> | undefined;

        const run: NonNullable<FinishUpdateParams["opts"]["run"]> = {
          runId: created.runId,
          env: state.env,
        };
        const execution = () =>
          withUpdateCommandExecutor(created.runId, async (executor) => {
            // Revocation uses the real direct-owner release API. No synthetic assertCurrent
            // or plugin lease substitutes for the native executor's ownership check.
            const fence = await executor.enter(state.root, { preflight: true });
            run.executorFence = fence;
            assertOriginalCurrent = fence.assertCurrent;
            return withUpdateCommandExecutor("independent-live-owner", async (otherExecutor) => {
              const otherFence = await otherExecutor.enter(otherRoot);
              const params: FinishUpdateParams = {
                root: state.root,
                result: {
                  status: "skipped",
                  reason: "already-current",
                  mode: "npm",
                  root: state.root,
                  steps: [],
                  durationMs: 0,
                },
                coreAlreadyCurrent: true,
                mutationStarted: false,
                shouldRestart: false,
                installKindChanged: false,
                configSnapshot,
                requestedChannel: null,
                storedChannel: "stable",
                channel: "stable",
                downgradeRisk: false,
                opts: { json: true, yes: true, run },
                controlPlaneUpdateSentinelMeta: null,
                preUpdatePluginInstallRecords: {},
                startedAt: Date.now(),
                updateStepTimeoutMs: 1_000,
              };
              const converge = convergence.runPostCorePluginConvergence;
              vi.spyOn(convergence, "runPostCorePluginConvergence").mockImplementationOnce(
                async (input) => {
                  const result = await converge(input);
                  fence.assertCurrent();
                  otherFence.assertCurrent();
                  indexAtConvergence = readIndex();
                  runAtConvergence = getUpdateRun(created.runId, { env: state.env });
                  if (scenario === "index-revoked") {
                    releaseUpdateCommandPreflightForHandoff(fence);
                  } else if (scenario === "run-replaced") {
                    params.opts.run = { ...run };
                  } else if (scenario === "fence-replaced") {
                    run.executorFence = otherFence;
                  }
                  return result;
                },
              );
              const prepare = configPreparation.preparePostCorePluginConfig;
              vi.spyOn(configPreparation, "preparePostCorePluginConfig").mockImplementationOnce(
                async (input) => {
                  const prepared = await prepare(input);
                  const beforeCommit = prepared.configWriteOptions.beforeCommit;
                  prepared.configWriteOptions.beforeCommit = async () => {
                    await beforeCommit?.();
                    configBoundaryReached = true;
                    if (scenario === "config-revoked") {
                      fence.assertCurrent();
                      expect(readIndex()).not.toEqual(indexAtConvergence);
                      releaseUpdateCommandPreflightForHandoff(fence);
                    }
                  };
                  return prepared;
                },
              );
              try {
                completed = await finishUpdate(params);
              } catch (cause) {
                refused = cause;
                // Refusal cannot rewrite history before terminal settlement. The later
                // terminal row is diagnostic publication, not renewed mutation authority.
                expect(getUpdateRun(created.runId, { env: state.env })).toEqual(runAtConvergence);
                expect(json).not.toHaveBeenCalled();
                throw cause;
              }
            });
          });
        const terminal = withUpdateFailureTriage(
          { json: true, yes: true, run },
          { root: state.root, env: targetEnv },
          async () => {
            await withUpdateCommandTerminalResult(run, execution);
          },
        );
        if (scenario === "healthy") {
          await terminal;
          expect(refused).toBeUndefined();
          expect(completed).toMatchObject({
            status: "ok",
            postUpdate: { plugins: { changed: true, status: "ok", warnings: [] } },
          });
          expect(JSON.parse(await fs.readFile(state.configPath, "utf8")).channels).toEqual(
            authoredChannels,
          );
          expect(readIndex()).not.toEqual(indexAtConvergence);
          expect(runAtPublication?.status).toBe("succeeded");
          expect(configBoundaryReached).toBe(true);
          expect(transport.exec).toHaveBeenCalled();
        } else {
          await expect(terminal).rejects.toMatchObject({ code: 1, name: new ExitError(1).name });
          expect(refused).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
          expect(refused).toMatchObject({
            automaticTriage: undefined,
            result: { status: "error" },
          });
          expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
          // Config refusal rolls back the tentative index through its existing owner.
          // Index refusal must not write even a new index revision.
          if (scenario === "config-revoked") {
            expect(JSON.parse(readIndex()!.value_json).index).toEqual(
              JSON.parse(indexAtConvergence!.value_json).index,
            );
            expect(configBoundaryReached).toBe(true);
          } else {
            expect(readIndex()).toEqual(indexAtConvergence);
            expect(configBoundaryReached).toBe(false);
          }
          const reported = json.mock.calls[0]?.[0];
          expect(reported).toMatchObject({
            status: "error",
            reason: "update-executor-settlement-failed",
            steps: [
              {
                name: "update executor settlement",
                exitCode: 1,
                stderrTail: expect.stringContaining(
                  scenario === "run-replaced" || scenario === "fence-replaced"
                    ? "Package finalization lost its original executor."
                    : "Update executor ownership is no longer current.",
                ),
              },
            ],
          });
          expect(runAtPublication).toMatchObject({
            status: "failed",
            reason: "update-executor-settlement-failed",
          });
          expect(transport.exec).not.toHaveBeenCalled();
          expect(error).not.toHaveBeenCalled();
        }
        expect(indexAtConvergence).toBeDefined();
        expect(runAtPublication).toBeDefined();
        expect(getUpdateRun(created.runId, { env: state.env })).toEqual(runAtPublication);
        expect(await fs.readFile(diagnosticPath, "utf8")).toBe("retained diagnostic\n");
        expect(transport.command).not.toHaveBeenCalled();
        expect(json.mock.calls).toHaveLength(1);
        expect(log).not.toHaveBeenCalled();
      },
    );
  });
});

it.each([false, true])(
  "captures before current-core plugin effects and carries the same Doctor ref (changed=%s)",
  async (changed) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const actualExec =
        await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
      transport.exec.mockImplementation((file, args, options) => {
        if (file === "/bin/ls" || file === "/usr/bin/dsmemberutil") {
          return actualExec.runExec(file, args, options);
        }
        throw new Error(`Unexpected external command: ${file}`);
      });
      const root = state.path("install");
      const control = state.path("control");
      await fs.mkdir(root);
      await fs.mkdir(control);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: VERSION }),
      );
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await state.writeConfig({ plugins: { enabled: false } });
      const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const events: string[] = [];
      let backup: UpdateRecoveryBackupRef | undefined;
      const pluginResult = {
        status: "ok" as const,
        changed,
        sync: { changed, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
        npm: { changed, outcomes: [] },
        integrityDrifts: [],
        warnings: [],
      };
      vi.spyOn(pluginUpdater, "updatePluginsAfterCoreUpdate").mockImplementationOnce(
        async (params) => {
          if (changed) {
            await params.beforePersistentEffect?.();
            events.push("effect");
          }
          return pluginResult;
        },
      );
      const doctor = vi
        .spyOn(freshDoctor, "completePostCorePluginUpdate")
        .mockImplementationOnce(async (params) => {
          await params.beforeDoctor?.();
          events.push("doctor");
          expect(params.updateRecoveryBackup).toBeDefined();
          expect(params.updateRecoveryBackup).toEqual(backup);
          return { pluginUpdate: pluginResult, configSnapshot };
        });
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(root);
        const prepare = vi.fn(async () => {
          backup = await createUpdateRecoveryBackup({
            runId: run.runId,
            installRoot: root,
            assertOwned: () => fence.assertCurrent(),
          });
          events.push("capture");
          return backup;
        });
        const result = await convergeUpdatePlugins(
          {
            coreAlreadyCurrent: true,
            preparePersistentMutation: prepare,
            result: {
              status: "skipped",
              mode: "npm",
              root,
              reason: "already-current",
              before: { version: VERSION },
              after: { version: VERSION },
              steps: [],
              durationMs: 0,
            },
            root,
            installKindChanged: false,
            configSnapshot,
            requestedChannel: null,
            storedChannel: null,
            channel: "stable",
            downgradeRisk: false,
            opts: { json: true, run: { runId: run.runId, env: state.env, executorFence: fence } },
            preUpdatePluginInstallRecords: {},
            startedAt: Date.now(),
            updateStepTimeoutMs: 1000,
          },
          () => fence.assertCurrent(),
        );
        expect(result.resultWithPostUpdate.status).toBe(changed ? "ok" : "skipped");
        expect(prepare).toHaveBeenCalledTimes(changed ? 1 : 0);
        expect(doctor).toHaveBeenCalledTimes(changed ? 1 : 0);
      });
      expect(events).toEqual(changed ? ["capture", "effect", "doctor"] : []);
    });
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "settles plugin descendants before restoring state (current core=%s)",
  async (coreAlreadyCurrent) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const root = state.path("install");
      const control = state.path("control");
      await fs.mkdir(root);
      await fs.mkdir(control);
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await state.writeConfig({ plugins: { enabled: false } });
      const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
      const marker = state.path("restored-state.txt");
      await fs.writeFile(marker, "before update");
      const descendantCode = `const fs = require('node:fs');process.on('SIGTERM',()=>{});setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'late mutation');process.exit(0);},800);process.send('ready');`;
      const launcherCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.send(child.pid,()=>{child.disconnect();process.exit(1);}));`;
      let launcher: ChildProcess | undefined;
      let launcherResult: Promise<unknown> | undefined;
      let descendantPid: number | undefined;
      vi.spyOn(pluginUpdater, "updatePluginsAfterCoreUpdate").mockImplementationOnce(async () => {
        const command = spawnCommand([process.execPath, "-e", launcherCode], {
          stdio: ["ignore", "pipe", "pipe"],
          ipc: true,
          reject: false,
        });
        launcher = command.nodeChildProcess;
        launcherResult = command;
        const [pid] = await once(launcher, "message", {
          signal: AbortSignal.timeout(3_000),
        });
        descendantPid = Number(pid);
        await launcherResult;
        throw new Error("synthetic plugin convergence failure");
      });
      const rollback = vi
        .spyOn(rollbackOwner, "rollbackFailedUpdate")
        .mockImplementationOnce(async ({ result }) => {
          await fs.writeFile(marker, "restored");
          return { result, rolledBack: true, stateRestored: true };
        });
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const created = createUpdateRun({ trigger: "cli" }, { env: state.env });
      try {
        await expect(
          withUpdateCommandExecutor(created.runId, async (executor) => {
            const fence = await executor.enter(root);
            await finishUpdate({
              coreAlreadyCurrent,
              mutationStarted: true,
              result: {
                status: "ok",
                mode: "npm",
                root,
                before: { version: VERSION },
                after: { version: VERSION },
                steps: [],
                durationMs: 0,
              },
              root,
              installKindChanged: false,
              configSnapshot,
              requestedChannel: null,
              storedChannel: null,
              channel: "stable",
              downgradeRisk: false,
              shouldRestart: false,
              opts: {
                json: true,
                run: { runId: created.runId, env: state.env, executorFence: fence },
              },
              controlPlaneUpdateSentinelMeta: null,
              preUpdatePluginInstallRecords: {},
              startedAt: Date.now(),
              updateStepTimeoutMs: 1000,
              packageTransaction: {
                backupRoot: state.path("retained-package"),
                rollback: vi.fn(),
                complete: async () => {},
              },
            });
          }),
        ).rejects.toThrow("synthetic plugin convergence failure");
        expect(rollback).toHaveBeenCalledOnce();
        expect(descendantPid).toBeGreaterThan(0);
        expect(await waitForPidToExit(descendantPid!)).toBe(true);
        expect(await fs.readFile(marker, "utf8")).toBe("restored");
      } finally {
        killPidIfAlive(descendantPid);
        killPidIfAlive(launcher?.pid);
        await launcherResult;
        if (descendantPid) {
          await waitForPidToExit(descendantPid);
        }
      }
    });
  },
);

it("converges a fresh protected worker without a raw compatibility handoff", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const root = state.path("install");
    await fs.mkdir(root);
    await state.writeConfig({ plugins: { enabled: false } });
    const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    const pluginResult = {
      status: "ok" as const,
      changed: false,
      sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
      npm: { changed: false, outcomes: [] },
      integrityDrifts: [],
      warnings: [],
    };
    vi.spyOn(postCoreOwner, "shouldResumePostCoreUpdateInFreshProcess").mockReturnValue(true);
    vi.spyOn(postCoreOwner, "continuePostCoreUpdateInFreshProcess").mockRejectedValue(
      new Error("raw compatibility handoff launched"),
    );
    vi.spyOn(pluginUpdater, "updatePluginsAfterCoreUpdate").mockResolvedValue(pluginResult);
    vi.spyOn(freshDoctor, "completePostCorePluginUpdate").mockResolvedValue({
      pluginUpdate: pluginResult,
      configSnapshot,
    });
    await expect(
      convergeUpdatePlugins({
        deferFailureRecoveryToParent: true,
        result: {
          status: "ok",
          mode: "npm",
          root,
          before: { version: "2026.9.3" },
          after: { version: VERSION },
          steps: [],
          durationMs: 0,
        },
        root,
        installKindChanged: false,
        configSnapshot,
        requestedChannel: null,
        storedChannel: null,
        channel: "stable",
        downgradeRisk: false,
        opts: { json: true },
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ resultWithPostUpdate: { status: "ok" } });
  });
});
