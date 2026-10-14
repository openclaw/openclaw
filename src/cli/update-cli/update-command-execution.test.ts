// Install the fixture mocks before loading the execution owner and its dependencies.
import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { UpdatePreMutationError } from "./shared.js";
import { registerExecutionFailureTests } from "./update-command-execution-failures.test-support.js";
import { registerNativeAdmissionTests } from "./update-command-execution-native-admission.test-support.js";
import { registerExecutionTimeoutTests } from "./update-command-execution-timeouts.test-support.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import * as readiness from "./update-command-readiness.js";
import { registerServiceCollectionTests } from "./update-command-service-collection.test-support.js";

const { bindExecutionGuards, executionParams, inspectOrStopService, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

describe("mutable update execution", () => {
  registerServiceCollectionTests();
  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      (["deferred", "advisory", "failure"] as const).map((outcome) => ({ kind, outcome })),
    ),
  )(
    "scopes $kind verification deferral to state contention ($outcome)",
    async ({ kind, outcome }) => {
      const options = executionParams(kind);
      options.opts.restart = options.shouldRestart = false;
      const deferred = {
        name: "post-install-verify",
        command: "verify installed package",
        cwd: options.root,
        exitCode: outcome === "advisory" ? 0 : null,
        durationMs: 0,
        advisory: {
          kind: "recoverable-maintenance" as const,
          message: "State verification deferred to the operator restart.",
        },
      };
      const install = kind === "package" ? mocks.runPackageUpdate : mocks.runGitUpdate;
      const result = {
        ...successfulUpdate,
        ...(outcome === "failure" ? { status: "error", reason: "post-update-failed" } : {}),
        steps: [deferred],
      };
      install.mockResolvedValueOnce(result);
      const execution = await executeMutableUpdate(await bindExecutionGuards(options));
      expect(execution?.result).toMatchObject({
        status: outcome === "deferred" ? "skipped" : outcome === "failure" ? "error" : "ok",
        steps: [deferred],
      });
      expect(execution?.result.reason).toBe(
        outcome === "deferred"
          ? "gateway-readiness-unverified"
          : outcome === "failure"
            ? "post-update-failed"
            : undefined,
      );
    },
  );

  registerExecutionTimeoutTests();

  registerNativeAdmissionTests({ executionParams, mocks, successfulUpdate });
  it.each(["same", "alias", "disjoint"] as const)(
    "preserves a serving Git runtime when activation did not stop it: %s",
    async (destination) => {
      await withTestDir({ prefix: "git-live-runtime-custody-" }, async (dir) => {
        const servingRoot = path.join(dir, "serving");
        const targetRoot = destination === "same" ? servingRoot : path.join(dir, "target");
        await fs.mkdir(path.join(servingRoot, "dist"), { recursive: true });
        if (destination === "alias") {
          await fs.symlink(
            servingRoot,
            targetRoot,
            process.platform === "win32" ? "junction" : "dir",
          );
        } else if (destination === "disjoint") {
          await fs.mkdir(path.join(targetRoot, "dist"), { recursive: true });
        }
        const artifact = path.join(servingRoot, "dist", "prepare.runtime.js");
        await fs.writeFile(artifact, "retained serving runtime");
        const target = { schemaVersions: { state: 15, agent: 19 } };
        mocks.maybeStopService.mockImplementation(async () => ({
          ...inspectOrStopService("inspect"),
          servicePid: 23456,
          serviceUpdateVerdict: {
            kind: "owned",
            root: servingRoot,
            fingerprint: "serving-generation",
            refreshDefinition: false,
          },
        }));
        vi.spyOn(readiness, "verifyPreviousGatewayForUpdate").mockResolvedValue(true);
        mocks.runGitUpdate.mockImplementation(
          async (
            options: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
          ) => {
            await options.inspectGitTarget?.(target);
            await options.beforeGitMutation?.(target);
            await fs.writeFile(
              path.join(targetRoot, "dist", "prepare.runtime.js"),
              "candidate runtime",
            );
            return { ...successfulUpdate, mode: "git" };
          },
        );
        const execution = await executeMutableUpdate(
          await bindExecutionGuards({
            ...executionParams("git"),
            root: targetRoot,
            shouldRestart: false,
            opts: { json: true, restart: false },
          }),
        );
        expect(await fs.readFile(artifact, "utf8")).toBe("retained serving runtime");
        expect(mocks.serviceStopped).toBe(false);
        if (destination === "disjoint") {
          expect(execution?.result.status).toBe("ok");
          expect(
            await fs.readFile(path.join(targetRoot, "dist", "prepare.runtime.js"), "utf8"),
          ).toBe("candidate runtime");
        } else {
          expect(execution).toMatchObject({
            mutationStarted: false,
            result: { status: "error", reason: "runtime-artifact-publication" },
          });
          expect(execution?.result.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ stderrTail: expect.stringContaining("23456") }),
            ]),
          );
        }
      });
    },
  );
  it("retains the live update run when stopped-service context capture fails", async () => {
    await withTestDir({ prefix: "partial-stop-recovery-owner-" }, async (dir) => {
      const control = path.join(dir, "leases");
      await fs.mkdir(control);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const env = { OPENCLAW_STATE_DIR: dir };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const params = executionParams("package");
      params.root = dir;
      params.opts.run = { runId, env };
      mocks.maybeStopService.mockImplementation(async () => ({
        ...inspectOrStopService("prepare"),
        serviceEnv: env,
        serviceUpdateVerdict: {
          kind: "owned",
          root: dir,
          fingerprint: "original",
          refreshDefinition: false,
        },
      }));
      mocks.captureManagedContext.mockRejectedValueOnce(
        new Error("fixture config became unreadable"),
      );
      let recoveryRun: typeof params.opts.run;
      mocks.maybeRestartService.mockImplementation(async (request) => {
        recoveryRun = request.updateRun;
        recoveryRun?.executorFence?.assertCurrent();
        return "healthy";
      });
      await withUpdateCommandExecutor(runId, async (executor) => {
        params.opts.run!.executorFence = await executor.enter(dir, { preflight: true });
        const result = await executeMutableUpdate(await bindExecutionGuards(params));
        expect(result?.result.status).toBe("error");
        expect(mocks.maybeRestartService).toHaveBeenCalledOnce();
        expect(recoveryRun).toBe(params.opts.run);
        expect(mocks.serviceStopped).toBe(true);
        expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
      });
    });
  });

  it("refuses service admission before mutable startup housekeeping", async () => {
    mocks.maybeStopService.mockImplementation(async ({ phase, handoffFromGateway }) => {
      if (handoffFromGateway) {
        throw new UpdatePreMutationError("managed-service-preflight", "service owner changed");
      }
      return inspectOrStopService(phase);
    });
    const execution = await executeMutableUpdate(
      await bindExecutionGuards(executionParams("package")),
    );
    expect(execution).toMatchObject({
      mutationStarted: false,
      result: { status: "error", reason: "managed-service-preflight" },
    });
    expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    expect(mocks.serviceStopped).toBe(false);
  });

  it.each([{ kind: "package", shouldRestart: false }] as const)(
    "admits FreeBSD $kind with a service advisory and restart=$shouldRestart",
    async ({ kind, shouldRestart }) =>
      withEnvAsync(
        {
          OPENCLAW_SUPERVISOR_MODE: undefined,
          OPENCLAW_HOME: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: undefined,
          OPENCLAW_CONFIG_PATH: undefined,
        },
        async () => {
          mockProcessPlatform("freebsd");
          mockSystemAccountHome();
          const maintenance = await vi.importActual<
            typeof import("./update-command-service-maintenance.js")
          >("./update-command-service-maintenance.js");
          mocks.maybeStopService.mockImplementation(
            maintenance.maybeStopManagedServiceBeforeMutableUpdate,
          );

          const execution = await executeMutableUpdate(
            await bindExecutionGuards({
              ...executionParams(kind),
              shouldRestart,
              opts: { json: true, restart: shouldRestart },
            }),
          );

          expect(execution?.result.status).toBe("ok");
          if (kind === "package") {
            expect(execution?.preManagedServiceStop).toMatchObject({
              serviceMutationAllowed: false,
              serviceUpdateVerdict: { kind: "unavailable" },
              serviceMutationSkipMessage: expect.stringContaining(
                "rc.d or foreground process owner",
              ),
            });
            expect(execution?.preManagedServiceStop?.serviceMutationSkipMessage).toContain(
              "Restart the Gateway you launched manually",
            );
          }
          expect(mocks.serviceStopped).toBe(false);
          expect(
            kind === "package" ? mocks.runPackageUpdate : mocks.runGitUpdate,
          ).toHaveBeenCalled();
        },
      ),
  );

  it.each([{ metadata: "missing", openclaw: undefined }])(
    "retains registry schema admission when staged metadata is $metadata",
    async ({ openclaw }) => {
      await withTestDir({ prefix: "openclaw-staged-schema-retention-" }, async (stage) => {
        await fs.writeFile(
          path.join(stage, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.9.2", openclaw }),
        );
        mocks.checkTargetSchemas.mockImplementation(async (versions) => ({
          incompatible:
            versions?.state === 15
              ? [
                  {
                    kind: "state",
                    path: "/fixture/default/state.sqlite",
                    foundVersion: 17,
                    supportedVersion: 15,
                  },
                ]
              : [],
          indeterminate: [],
        }));
        mocks.runPackageUpdate.mockImplementation(async ({ validateCandidate, beforeActivate }) => {
          await validateCandidate(stage);
          await beforeActivate();
          return successfulUpdate;
        });

        const execution = await executeMutableUpdate(
          await bindExecutionGuards({
            ...executionParams("package"),
            tag: "2026.9.2",
            packageInstallSpec: "openclaw@2026.9.2",
            packageTargetVersion: "2026.9.2",
          }),
        );

        expect(mocks.validateCanary).toHaveBeenCalledOnce();
        expect(execution).toMatchObject({
          mutationStarted: false,
          result: { status: "error", reason: "database-schema-preflight" },
        });
        expect(mocks.serviceStopped).toBe(false);
      });
    },
  );

  it.each([
    { failure: "missing", contract: "api", range: ">=1.0.0", incompatible: false },
    { failure: "missing", contract: "api", range: ">=1.0.0 <1.0.1", incompatible: true },
    { failure: "metadata", contract: "host", range: ">=1.0.2", incompatible: true },
    { failure: "throw", contract: "host", range: ">=1.0.2", incompatible: true },
  ])(
    "preserves plugin admission and exception handling ($failure, $contract, $range)",
    async ({ failure, contract, range, incompatible }) => {
      await withTestDir({ prefix: "openclaw-plugin-admission-" }, async (installPath) => {
        await fs.writeFile(
          path.join(installPath, "package.json"),
          JSON.stringify({
            name: "@example/demo",
            version: "1.0.0",
            openclaw:
              contract === "api"
                ? { compat: { pluginApi: range } }
                : { install: { minHostVersion: range } },
          }),
        );
        mocks.pluginRecords.mockResolvedValue({
          demo: { source: "npm", spec: "@example/demo@1.0.1", version: "1.0.0", installPath },
        });
        mocks.pluginTargets.mockResolvedValue([{ pluginId: "demo", spec: "@example/demo@1.0.1" }]);
        const error =
          failure === "missing"
            ? "No matching version found"
            : "registry connection failed: ECONNRESET";
        const metadataFailure = new Error(error);
        if (failure === "throw") {
          mocks.npmMetadata.mockRejectedValue(metadataFailure);
        } else {
          mocks.npmMetadata.mockResolvedValue({
            ok: false,
            category: failure === "metadata" ? "metadata-env" : undefined,
            error,
          });
        }
        const actual = await vi.importActual<typeof import("./update-command-plugin-preflight.js")>(
          "./update-command-plugin-preflight.js",
        );
        mocks.pluginPreflight.mockImplementation(actual.preflightConfiguredNpmPluginTargets);

        const execution = await executeMutableUpdate(
          await bindExecutionGuards(executionParams("package")),
        );
        const unclassifiedFailure = incompatible && failure === "throw";

        expect(execution?.result.status).toBe(unclassifiedFailure ? "error" : "ok");
        expect(mocks.npmMetadata).toHaveBeenCalledTimes(incompatible ? 1 : 0);
        expect(mocks.serviceStopped).toBe(false);
        if (unclassifiedFailure) {
          expect(execution?.result.reason).toBe("update-failed");
          expect(execution?.failure?.cause).toBe(metadataFailure);
          expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
          expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
        } else {
          const warnings = await mocks.pluginPreflight.mock.results[0]?.value;
          expect(execution?.result.reason).toBeUndefined();
          expect(mocks.prepareMutableUpdate).toHaveBeenCalledOnce();
          expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
          if (incompatible) {
            expect(warnings).toEqual([
              expect.objectContaining({
                pluginId: "demo",
                reason: expect.stringContaining(range),
                message:
                  'Plugin "demo" update availability could not be confirmed; the core update can continue.',
                guidance: [],
              }),
            ]);
            expect(warnings[0]?.reason).toContain("Installed 1.0.0");
            expect(warnings[0]?.reason).toContain("@example/demo@1.0.1");
            expect(warnings[0]?.reason).toContain(error);
            if (failure === "metadata") {
              expect(warnings[0]?.reason).toContain("registry could not be reached");
            }
            expect(mocks.runtimeError).toHaveBeenCalledWith(warnings[0]?.message);
          } else {
            expect(warnings).toEqual([]);
          }
        }
      });
    },
  );

  it("waits for plugin availability before preparing a package update", async () => {
    const available = createDeferred<[]>();
    mocks.pluginPreflight.mockImplementation(() => available.promise);
    const execution = executeMutableUpdate(await bindExecutionGuards(executionParams("package")));
    try {
      await vi.waitFor(() => expect(mocks.pluginPreflight).toHaveBeenCalledOnce());
      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    } finally {
      available.resolve([]);
    }
    expect((await execution)?.result).toBe(successfulUpdate);
    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
  });

  registerExecutionFailureTests();

  it.each([false, true])(
    "checks Git schema compatibility before activation: incompatible=%s",
    async (incompatible) => {
      await withTestDir({ prefix: "git-selection-online-" }, async (root) => {
        const events: string[] = [];
        const target = { schemaVersions: { state: 14, agent: 18 } };
        const beginMutation = vi.fn(() => {
          expect(mocks.serviceStopped).toBe(true);
          events.push("mutation");
        });
        const onActivation = vi.fn();
        mocks.checkTargetSchemas.mockImplementation(async (versions) => {
          expect(mocks.serviceStopped).toBe(false);
          expect(versions).toEqual(target.schemaVersions);
          events.push("activation-schema");
          return {
            incompatible: incompatible
              ? [
                  {
                    kind: "state",
                    path: "/fixture/default/state.sqlite",
                    foundVersion: 17,
                    supportedVersion: 14,
                  },
                ]
              : [],
            indeterminate: [],
          };
        });
        mocks.maybeStopService.mockImplementation(async ({ phase }) => {
          if (phase === "prepare") {
            events.push("stop");
          }
          const state = inspectOrStopService(phase);
          if (state.serviceUpdateVerdict?.kind === "owned") {
            state.serviceUpdateVerdict = { ...state.serviceUpdateVerdict, root };
          }
          state.windowsTaskAutoStartRecovery = {
            suspended: Promise.resolve(true),
            beginMutation,
            assertRecoveryCurrent: () => {},
            restore: vi.fn(async () => {}),
            handoff: vi.fn(),
            complete: vi.fn(async () => {}),
            interrupted: () => false,
          };
          return state;
        });
        // Readiness timing/failure semantics use the real probe in execution-validation.test.ts.
        // This fixture checks execution ordering around an already verified runtime.
        vi.spyOn(readiness, "verifyPreviousGatewayForUpdate").mockImplementation(
          async ({ assertCurrent }) => {
            assertCurrent?.();
            expect(mocks.serviceStopped).toBe(false);
            events.push("verified");
            return true;
          },
        );
        mocks.runGitUpdate.mockImplementation(
          async (
            params: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
          ) => {
            if (!params.inspectGitTarget || !params.beforeGitMutation) {
              throw new Error("Expected both real Git admission callbacks");
            }
            await params.inspectGitTarget(target);
            events.push("git");
            expect(mocks.serviceStopped).toBe(false);
            await params.beforeGitMutation(target);
            return { ...successfulUpdate, mode: "git" };
          },
        );

        const coordinator = path.join(root, "coordinator");
        await fs.mkdir(coordinator);
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(coordinator);
        const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
        const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
        const params = { ...executionParams("git"), root, onActivation };
        params.opts.run = { runId, env };
        const execution = await withUpdateCommandExecutor(runId, async (executor) => {
          mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
            events.push("mutable-prepare");
            admitExecutor(await executor.enter(root));
          });
          return executeMutableUpdate(await bindExecutionGuards(params));
        });

        expect(events).toEqual([
          "mutable-prepare",
          "git",
          "activation-schema",
          ...(incompatible ? [] : ["verified", "mutable-prepare", "stop", "mutation"]),
        ]);
        expect(mocks.serviceStopped).toBe(!incompatible);
        expect(beginMutation).toHaveBeenCalledTimes(incompatible ? 0 : 1);
        expect(onActivation).toHaveBeenCalledTimes(incompatible ? 0 : 1);
        expect(execution?.mutationStarted).toBe(!incompatible);
        expect(execution?.result.status, JSON.stringify(execution?.failure)).toBe(
          incompatible ? "error" : "ok",
        );
        if (incompatible) {
          expect(execution?.result.reason).toBe("database-schema-preflight");
        }
        expect(execution?.result.mode).toBe("git");
        expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
      });
    },
  );
});
