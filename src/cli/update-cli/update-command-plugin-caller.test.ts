import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import * as convergence from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as configIO from "../../config/io.factory.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../../plugins/installed-plugin-index-records.js";
import { auditDeclaredOpenClawHostDependency } from "../../plugins/plugin-peer-link.js";
import * as registryRefresh from "../../plugins/registry-refresh.js";
import {
  readPersistedInstalledPluginIndexRowSync,
  seedInstalledPluginIndex,
} from "../../plugins/test-helpers/installed-plugin-index.js";
import * as pluginUpdates from "../../plugins/update.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";
import * as configPreparation from "./update-command-config.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { finishParams } from "./update-command-maintenance-fixtures.test-support.js";
import * as postCore from "./update-command-post-core.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import * as postCoreResume from "./update-command-resume.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const transport = vi.hoisted(() => ({ exec: vi.fn(), command: vi.fn() }));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: transport.exec,
  runUtf8CommandWithTimeout: async ([command, ...args]: string[], options: unknown) => ({
    ...(await transport.exec(command, args, options)),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  }),
  runCommandWithTimeout: transport.command,
}));
// Doctor transports are inert; plugin/config persistence and executor custody are real.
vi.mock("./update-command-doctor-child.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-doctor-child.js")>()),
  inspectUpdateDoctorChildSupport: async () => true,
  withUpdateDoctorChild: async (
    params: Parameters<typeof import("./update-command-doctor-child.js").withUpdateDoctorChild>[0],
    operation: Parameters<
      typeof import("./update-command-doctor-child.js").withUpdateDoctorChild
    >[1],
  ) => {
    params.context.executorFence.assertCurrent();
    params.context.assertRequesterCurrent();
    const result = await operation(async (_argv, options) => ({
      ...(await transport.exec(
        process.execPath,
        [path.join(params.root, "dist", "entry.js"), "doctor"],
        options,
      )),
      code: 0,
      signal: null,
      killed: false,
      cleanup: "normal",
      termination: "exit",
    }));
    params.context.assertRequesterCurrent();
    params.context.executorFence.assertCurrent();
    return result;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

function afterResult<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
  observe: (result: Result) => void,
) {
  return async (...args: Args) => {
    const result = await operation(...args);
    observe(result);
    return result;
  };
}

const scenarios = [
  "healthy",
  "index-revoked",
  "config-revoked",
  "cohort-revoked",
  "host-link-recovery",
  "registry-revoked",
] as const;
async function exercisePersistence(state: OpenClawTestState, scenario: (typeof scenarios)[number]) {
  const candidateRuntime = scenario === "healthy" || scenario === "index-revoked";
  const control = state.path("control");
  const otherRoot = state.path("other-install");
  await fs.mkdir(control);
  await fs.mkdir(otherRoot);
  await fs.mkdir(state.path("dist"));
  await fs.writeFile(state.path("dist", "entry.js"), "// Inert transport fixture.\n");
  await state.writeJson("package.json", { name: "openclaw", version: VERSION });
  const peerPackageDir = state.statePath("npm", "node_modules", "peer-plugin");
  const peerLink = path.join(peerPackageDir, "node_modules", "openclaw");
  if (scenario === "host-link-recovery") {
    await fs.mkdir(path.dirname(peerLink), { recursive: true });
    await fs.writeFile(
      path.join(peerPackageDir, "package.json"),
      JSON.stringify({
        name: "peer-plugin",
        version: "1.0.0",
        peerDependencies: { openclaw: "*" },
      }),
    );
    await fs.symlink(state.root, peerLink, "junction");
  }
  const resolveInstallKind = updateCheck.resolveUpdateInstallKind;
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockImplementation(async (root, options) =>
    root === state.root ? "package" : resolveInstallKind(root, options),
  );
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  let assertOriginalCurrent: (() => void) | undefined;
  let runAtPublication: ReturnType<typeof getUpdateRun>;
  const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {
    // The CLI terminal owner publishes only after the real executor closes.
    expect(assertOriginalCurrent).toThrow();
    runAtPublication = getUpdateRun(created.runId, { env: state.env });
  });
  transport.command.mockReset().mockRejectedValue(new Error("Unexpected package/native command"));
  transport.exec.mockReset().mockImplementation(async (_file, args: string[]) => {
    if (args[0] !== state.path("dist", "entry.js")) {
      throw new Error("Unexpected external entrypoint");
    }
    if (args[1] === "doctor" || (args[1] === "config" && args[2] === "validate")) {
      return { stdout: JSON.stringify({ ok: true, checksRun: 1, findings: [] }), stderr: "" };
    }
    throw new Error("Unexpected external command");
  });

  // Real snapshots restore a dropped channel, forcing a plugin commit without a fetch.
  const authoredChannels = { telegram: { enabled: false } };
  await state.writeConfig({ plugins: { enabled: false }, channels: authoredChannels });
  let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  const currentConfig = { plugins: { enabled: false } };
  await state.writeConfig(currentConfig);
  const installRecords: Record<string, PluginInstallRecord> =
    scenario === "host-link-recovery"
      ? { "peer-plugin": { source: "npm", installPath: peerPackageDir } }
      : {};
  await seedInstalledPluginIndex(installRecords, { config: currentConfig, env: state.env });
  const readConfig = () => fs.readFile(state.configPath, "utf8");
  const originalConfig = await readConfig();
  const diagnosticPath = await state.writeText("retained-diagnostic.json", "retained diagnostic\n");
  const metaPath = await state.writeJson("sentinel-meta.json", {
    version: 1,
    meta: { triageContextPath: diagnosticPath },
  });
  const targetEnv = {
    ...state.env,
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
  };
  let created = createUpdateRun({ trigger: "cli" }, { env: state.env });
  const readRun = (runId = created.runId) => getUpdateRun(runId, { env: state.env });
  let preUpdatePluginInstallRecords = installRecords;
  const readIndex = () => readPersistedInstalledPluginIndexRowSync({ env: state.env });
  let indexAtConvergence: ReturnType<typeof readIndex>;
  let indexAtRevocation: ReturnType<typeof readIndex>;
  let runAtConvergence: ReturnType<typeof getUpdateRun>;
  const captureBoundary = () => {
    indexAtConvergence = readIndex();
    runAtConvergence = readRun();
  };
  let configBoundaryReached = false;
  let refused: unknown;
  let terminalFailure: UpdateCommandPendingRecoveryFailure | undefined;
  let completed: Awaited<ReturnType<typeof finishUpdate>> | undefined;
  const cohortScenario = scenario === "cohort-revoked";
  const npmUpdates = vi.spyOn(pluginUpdates, "updateNpmInstalledPlugins");
  const phase = vi.spyOn(postCoreResume, "convergePostCoreUpdatePlugins");
  const delegate = vi.spyOn(postCore, "continuePostCoreUpdateInFreshProcess");
  let recovering = false;
  let configAtRegistryRead: string | undefined;
  let registryRefusal: unknown;
  const converge = convergence.runPostCorePluginConvergence;
  const prepare = configPreparation.preparePostCorePluginConfig;
  const refresh = registryRefresh.refreshPluginRegistryAfterConfigMutation;

  let run: NonNullable<FinishUpdateParams["opts"]["run"]> = {
    runId: created.runId,
    env: state.env,
  };
  const execution = () =>
    withUpdateCommandExecutor(created.runId, async (executor) => {
      // Revoke the real executor, never a synthetic plugin lease.
      const fence = await executor.enter(state.root, { preflight: true });
      run.executorFence = fence;
      assertOriginalCurrent = fence.assertCurrent;
      return withUpdateCommandExecutor("independent-live-owner", async (otherExecutor) => {
        const otherFence = await otherExecutor.enter(otherRoot);
        const params = finishParams({
          root: state.root,
          result: resultFixture(state.root, {
            status: "skipped",
            reason: "already-current",
          }),
          coreAlreadyCurrent: true,
          mutationStarted: false,
          shouldRestart: false,
          configSnapshot,
          opts: { json: true, yes: true, run },
          preUpdatePluginInstallRecords,
          updateStepTimeoutMs: 1_000,
        });
        const unlink = fsSync.unlinkSync.bind(fsSync);
        const unlinkSpy =
          scenario === "host-link-recovery" && !recovering
            ? vi.spyOn(fsSync, "unlinkSync").mockImplementation((file) => {
                unlink(file);
                if (file === peerLink) {
                  captureBoundary();
                  releaseUpdateCommandPreflightForHandoff(fence);
                }
              })
            : undefined;
        syncBuiltinESMExports();
        const revokeAtBoundary = () => {
          fence.assertCurrent();
          otherFence.assertCurrent();
          captureBoundary();
          if (scenario === "index-revoked" || scenario === "cohort-revoked") {
            releaseUpdateCommandPreflightForHandoff(fence);
          }
        };
        if (scenario === "registry-revoked") {
          vi.spyOn(
            registryRefresh,
            "refreshPluginRegistryAfterConfigMutation",
          ).mockImplementationOnce(async (input) => {
            const create = configIO.createConfigIO;
            const readSpy = vi.spyOn(configIO, "createConfigIO").mockImplementation((options) => {
              const io = create(options);
              return {
                ...io,
                readConfigFileSnapshot: async () => {
                  const snapshot = await io.readConfigFileSnapshot();
                  configAtRegistryRead = await readConfig();
                  captureBoundary();
                  releaseUpdateCommandPreflightForHandoff(fence);
                  return snapshot;
                },
              };
            });
            try {
              return await refresh(input);
            } catch (registryError) {
              registryRefusal = registryError;
              throw registryError;
            } finally {
              readSpy.mockRestore();
            }
          });
        }
        if (cohortScenario) {
          const sync = pluginUpdates.syncPluginsForUpdateChannel;
          vi.spyOn(pluginUpdates, "syncPluginsForUpdateChannel").mockImplementationOnce(
            afterResult(sync, revokeAtBoundary),
          );
        }
        vi.spyOn(convergence, "runPostCorePluginConvergence").mockImplementationOnce(
          afterResult(converge, () => {
            if (!cohortScenario) {
              revokeAtBoundary();
            }
          }),
        );
        vi.spyOn(configPreparation, "preparePostCorePluginConfig").mockImplementationOnce(
          afterResult(prepare, (prepared) => {
            const beforeCommit = prepared.configWriteOptions.beforeCommit;
            prepared.configWriteOptions.beforeCommit = async () => {
              await beforeCommit?.();
              configBoundaryReached = true;
              if (scenario === "config-revoked") {
                fence.assertCurrent();
                indexAtRevocation = readIndex();
                expect(indexAtRevocation).not.toEqual(indexAtConvergence);
                releaseUpdateCommandPreflightForHandoff(fence);
              }
            };
          }),
        );
        try {
          completed = await finishUpdate(params, { candidateRuntime });
        } catch (cause) {
          refused = cause;
          // Neither refusal nor its later diagnostic can rewrite history after
          // the original executor has relinquished mutation authority.
          expect(readRun()).toEqual(runAtConvergence);
          expect(json).not.toHaveBeenCalled();
          throw cause;
        } finally {
          unlinkSpy?.mockRestore();
          syncBuiltinESMExports();
        }
      });
    });
  const finishWithTerminal = () =>
    withUpdateFailureTriage(
      { json: true, yes: true, run },
      { root: state.root, env: targetEnv },
      async () => {
        try {
          await withUpdateCommandTerminalResult((registerRun) => {
            registerRun(run);
            return execution();
          });
        } catch (cause) {
          assert(cause instanceof UpdateCommandPendingRecoveryFailure);
          terminalFailure = cause;
          throw cause;
        }
      },
    );
  const terminal = finishWithTerminal();
  if (scenario === "healthy") {
    await terminal;
    expect(refused).toBeUndefined();
    expect(terminalFailure).toBeUndefined();
    expect(completed).toMatchObject({
      status: "ok",
      postUpdate: { plugins: { changed: true, status: "ok", warnings: [] } },
    });
    expect(JSON.parse(await readConfig()).channels).toEqual(authoredChannels);
    expect(readIndex()).not.toEqual(indexAtConvergence);
    expect(runAtPublication?.status).toBe("succeeded");
    expect(configBoundaryReached).toBe(true);
    expect(transport.exec).toHaveBeenCalled();
  } else {
    await expect(terminal).rejects.toMatchObject({ code: 1, name: new ExitError(1).name });
    expect(refused).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    assert(refused instanceof UpdateCommandPendingRecoveryFailure);
    expect(refused).toMatchObject({
      result: {
        status: "error",
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      },
      cause: expect.objectContaining({
        message: expect.stringContaining("Update executor ownership is no longer current."),
      }),
    });
    expect(await readConfig()).toBe(
      scenario === "registry-revoked" ? configAtRegistryRead : originalConfig,
    );
    // A revoked caller cannot compensate even a tentative commit; preserve its exact row.
    if (scenario === "config-revoked") {
      expect(indexAtRevocation).toBeDefined();
      expect(readIndex()).toEqual(indexAtRevocation);
      expect(configBoundaryReached).toBe(true);
    } else {
      expect(readIndex()).toEqual(indexAtConvergence);
      expect(configBoundaryReached).toBe(scenario === "registry-revoked");
    }
    if (scenario === "registry-revoked") {
      expect(configAtRegistryRead).toBeDefined();
      expect(refused).toBe(registryRefusal);
    }
    const reported = json.mock.calls[0]?.[0];
    assert(terminalFailure instanceof UpdateCommandPendingRecoveryFailure);
    expect(terminalFailure.cause).toBe(refused);
    expect(reported).toEqual({ ...terminalFailure.result, reportPath: expect.any(String) });
    expect(reported).toMatchObject({
      status: "error",
      reason: "update-recovery-pending",
      steps: [
        {
          name: "update",
          exitCode: null,
          failureFacts: expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining("Update executor ownership is no longer current."),
            }),
          ]),
        },
      ],
    });
    expect(runAtConvergence).toBeDefined();
    expect(runAtPublication).toEqual(runAtConvergence);
    expect(transport.exec).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith(
      `Update recovery remains pending (update-recovery-pending). Retained state and artifacts were left for the owning updater to reconcile; automatic restart and repair were not attempted.\n${terminalFailure.detail}`,
    );
  }
  if (candidateRuntime) {
    expect(phase).toHaveBeenCalledOnce();
    expect(delegate).not.toHaveBeenCalled();
  }
  if (cohortScenario) {
    expect(npmUpdates).not.toHaveBeenCalled();
    expect(convergence.runPostCorePluginConvergence).not.toHaveBeenCalled();
  }
  expect(indexAtConvergence).toBeDefined();
  expect(readRun()).toEqual(runAtPublication);
  expect(await fs.readFile(diagnosticPath, "utf8")).toBe("retained diagnostic\n");
  expect(transport.command).not.toHaveBeenCalled();
  expect(json.mock.calls).toHaveLength(1);
  expect(log).not.toHaveBeenCalled();
  if (scenario === "host-link-recovery") {
    await expect(fs.lstat(peerLink)).rejects.toMatchObject({ code: "ENOENT" });
    const firstRunId = created.runId;
    const firstRunSnapshot = runAtConvergence;
    const firstAssertCurrent = assertOriginalCurrent;
    recovering = true;
    configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    preUpdatePluginInstallRecords =
      (await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: state.env })) ?? {};
    created = createUpdateRun({ trigger: "cli" }, { env: state.env });
    run = { runId: created.runId, env: state.env };
    completed = undefined;
    refused = undefined;
    terminalFailure = undefined;
    await finishWithTerminal();
    expect(firstAssertCurrent).toThrow();
    expect(readRun(firstRunId)).toEqual(firstRunSnapshot);
    expect(created.runId).not.toBe(firstRunId);
    expect(refused).toBeUndefined();
    expect(terminalFailure).toBeUndefined();
    expect(completed).toMatchObject({ status: "ok" });
    expect(runAtPublication?.status).toBe("succeeded");
    expect(await auditDeclaredOpenClawHostDependency({ packageDir: peerPackageDir })).toBeNull();
    expect(await fs.realpath(peerLink)).not.toBe(await fs.realpath(state.root));
    expect(json).toHaveBeenCalledTimes(2);
  }
}

it.each(scenarios)("protects persistence and terminal behavior with %s", async (scenario) => {
  await withOpenClawTestState(
    {
      label: `plugin-caller-${scenario}`,
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_UPDATE_RUN_HANDOFF: undefined },
    },
    (state) => exercisePersistence(state, scenario),
  );
});
