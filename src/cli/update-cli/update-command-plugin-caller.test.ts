import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as convergence from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as configIO from "../../config/io.factory.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexRowSync } from "../../plugins/installed-plugin-index-row.js";
import { auditDeclaredOpenClawHostDependency } from "../../plugins/plugin-peer-link.js";
import * as registryRefresh from "../../plugins/registry-refresh.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import * as pluginUpdates from "../../plugins/update.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";
import * as configPreparation from "./update-command-config.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import { finishUpdate, type FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
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
  syncBuiltinESMExports();
});

describe("connected in-process plugin finalization authority", () => {
  it.each([
    "healthy",
    "index-revoked",
    "config-revoked",
    "run-replaced",
    "fence-replaced",
    "cohort-revoked",
    "cohort-run-replaced",
    "cohort-fence-replaced",
    "host-link-recovery",
    "registry-revoked",
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
        const peerPackageDir = state.statePath("npm", "node_modules", "peer-plugin");
        const peerLink = state.statePath(
          "npm",
          "node_modules",
          "peer-plugin",
          "node_modules",
          "openclaw",
        );
        if (scenario === "host-link-recovery") {
          await fs.mkdir(state.statePath("npm", "node_modules", "peer-plugin", "node_modules"), {
            recursive: true,
          });
          await fs.writeFile(
            state.statePath("npm", "node_modules", "peer-plugin", "package.json"),
            JSON.stringify({
              name: "peer-plugin",
              version: "1.0.0",
              peerDependencies: { openclaw: "*" },
            }),
          );
          await fs.symlink(state.root, peerLink, "junction");
        }
        const resolveInstallKind = updateCheck.resolveUpdateInstallKind;
        vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockImplementation(
          async (root, options) =>
            root === state.root ? "package" : resolveInstallKind(root, options),
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
        let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
        const currentConfig = { plugins: { enabled: false } };
        await state.writeConfig(currentConfig);
        await seedInstalledPluginIndex({}, { config: currentConfig, env: state.env });
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
        let created = createUpdateRun({ trigger: "cli" }, { env: state.env });
        let preUpdatePluginInstallRecords = {};
        const readIndex = () => readPersistedInstalledPluginIndexRowSync({ env: state.env });
        let indexAtConvergence: ReturnType<typeof readIndex>;
        let indexAtRevocation: ReturnType<typeof readIndex>;
        let runAtConvergence: ReturnType<typeof getUpdateRun>;
        let configBoundaryReached = false;
        let refused: unknown;
        let completed: Awaited<ReturnType<typeof finishUpdate>> | undefined;
        const cohortScenario = scenario.startsWith("cohort-");
        const npmUpdates = vi.spyOn(pluginUpdates, "updateNpmInstalledPlugins");
        let convergenceReached = false;
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
                preUpdatePluginInstallRecords,
                startedAt: Date.now(),
                updateStepTimeoutMs: 1_000,
              };
              const unlink = fsSync.unlinkSync.bind(fsSync);
              const unlinkSpy =
                scenario === "host-link-recovery" && !recovering
                  ? vi.spyOn(fsSync, "unlinkSync").mockImplementation((file) => {
                      unlink(file);
                      if (file === peerLink) {
                        indexAtConvergence = readIndex();
                        runAtConvergence = getUpdateRun(created.runId, { env: state.env });
                        releaseUpdateCommandPreflightForHandoff(fence);
                      }
                    })
                  : undefined;
              syncBuiltinESMExports();
              const revokeAtBoundary = () => {
                fence.assertCurrent();
                otherFence.assertCurrent();
                indexAtConvergence = readIndex();
                runAtConvergence = getUpdateRun(created.runId, { env: state.env });
                if (scenario === "index-revoked" || scenario === "cohort-revoked") {
                  releaseUpdateCommandPreflightForHandoff(fence);
                } else if (scenario === "run-replaced" || scenario === "cohort-run-replaced") {
                  params.opts.run = { ...run };
                } else if (scenario === "fence-replaced" || scenario === "cohort-fence-replaced") {
                  run.executorFence = otherFence;
                }
              };
              if (scenario === "registry-revoked") {
                vi.spyOn(
                  registryRefresh,
                  "refreshPluginRegistryAfterConfigMutation",
                ).mockImplementationOnce(async (input) => {
                  const create = configIO.createConfigIO;
                  const readSpy = vi
                    .spyOn(configIO, "createConfigIO")
                    .mockImplementation((options) => {
                      const io = create(options);
                      return {
                        ...io,
                        readConfigFileSnapshot: async () => {
                          const snapshot = await io.readConfigFileSnapshot();
                          configAtRegistryRead = await fs.readFile(state.configPath, "utf8");
                          indexAtConvergence = readIndex();
                          runAtConvergence = getUpdateRun(created.runId, { env: state.env });
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
                  async (input) => {
                    const result = await sync(input);
                    revokeAtBoundary();
                    return result;
                  },
                );
              }
              vi.spyOn(convergence, "runPostCorePluginConvergence").mockImplementationOnce(
                async (input) => {
                  convergenceReached = true;
                  const result = await converge(input);
                  if (!cohortScenario) {
                    revokeAtBoundary();
                  }
                  return result;
                },
              );
              vi.spyOn(configPreparation, "preparePostCorePluginConfig").mockImplementationOnce(
                async (input) => {
                  const prepared = await prepare(input);
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
              await withUpdateCommandTerminalResult((registerRun) => {
                registerRun(run);
                return execution();
              });
            },
          );
        const terminal = finishWithTerminal();
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
          expect(await fs.readFile(state.configPath, "utf8")).toBe(
            scenario === "registry-revoked" ? configAtRegistryRead : originalConfig,
          );
          // A tentative commit is not permission to compensate after its caller is revoked.
          // Both refusal paths preserve the exact row, including its revision.
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
          expect(reported).toMatchObject({
            status: "error",
            reason: "update-executor-settlement-failed",
            steps: [
              {
                name: "update executor settlement",
                exitCode: 1,
                stderrTail: expect.stringContaining(
                  scenario.endsWith("run-replaced") || scenario.endsWith("fence-replaced")
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
        if (cohortScenario) {
          expect(npmUpdates).not.toHaveBeenCalled();
          expect(convergenceReached).toBe(false);
        }
        expect(indexAtConvergence).toBeDefined();
        expect(runAtPublication).toBeDefined();
        expect(getUpdateRun(created.runId, { env: state.env })).toEqual(runAtPublication);
        expect(await fs.readFile(diagnosticPath, "utf8")).toBe("retained diagnostic\n");
        expect(transport.command).not.toHaveBeenCalled();
        expect(json.mock.calls).toHaveLength(1);
        expect(log).not.toHaveBeenCalled();
        if (scenario === "host-link-recovery") {
          await expect(fs.lstat(peerLink)).rejects.toMatchObject({ code: "ENOENT" });
          const firstRunId = created.runId;
          const firstAssertCurrent = assertOriginalCurrent;
          recovering = true;
          configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
          preUpdatePluginInstallRecords =
            readPersistedInstalledPluginIndexInstallRecords({ env: state.env }) ?? {};
          created = createUpdateRun({ trigger: "cli" }, { env: state.env });
          run = { runId: created.runId, env: state.env };
          completed = undefined;
          refused = undefined;
          await finishWithTerminal();
          expect(firstAssertCurrent).toThrow();
          expect(getUpdateRun(firstRunId, { env: state.env })?.status).toBe("failed");
          expect(created.runId).not.toBe(firstRunId);
          expect(refused).toBeUndefined();
          expect(completed).toMatchObject({ status: "ok" });
          expect(runAtPublication?.status).toBe("succeeded");
          expect(
            await auditDeclaredOpenClawHostDependency({ packageDir: peerPackageDir }),
          ).toBeNull();
          expect(await fs.realpath(peerLink)).not.toBe(await fs.realpath(state.root));
          expect(json).toHaveBeenCalledTimes(2);
        }
      },
    );
  });
});
