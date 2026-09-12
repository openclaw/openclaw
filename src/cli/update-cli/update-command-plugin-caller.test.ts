import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as convergence from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexRowSync } from "../../plugins/installed-plugin-index-row.js";
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
            await withUpdateCommandTerminalResult((registerRun) => {
              registerRun(run);
              return execution();
            });
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
