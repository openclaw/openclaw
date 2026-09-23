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

const { executionParams, inspectOrStopService, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

describe("mutable update execution", () => {
  registerExecutionTimeoutTests();

  registerNativeAdmissionTests({ executionParams, mocks, successfulUpdate });
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
        const result = await executeMutableUpdate(params);
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
    const execution = await executeMutableUpdate(executionParams("package"));
    expect(execution).toMatchObject({
      mutationStarted: false,
      result: { status: "error", reason: "managed-service-preflight" },
    });
    expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    expect(mocks.serviceStopped).toBe(false);
  });

  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [false, true].map((shouldRestart) => ({ kind, shouldRestart })),
    ),
  )(
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

          const execution = await executeMutableUpdate({
            ...executionParams(kind),
            shouldRestart,
            opts: { json: true, restart: shouldRestart },
          });

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

  it.each(["admission", "execution"] as const)(
    "preserves native inspection reasons through admitted %s",
    async (phase) => {
      mocks.maybeStopService.mockImplementation(async ({ handoffFromGateway }) => {
        if (phase === "admission" || handoffFromGateway) {
          return {
            stopped: false,
            inspected: false,
            runtimeInspected: false,
            running: false,
            serviceMutationAllowed: false,
            serviceUpdateVerdict: {
              kind: "unavailable",
              message: "The systemd user session bus is unavailable.",
              inspectionReason: "systemd-user-bus-unavailable",
            },
            serviceMutationSkipMessage: "The systemd user session bus is unavailable.",
          };
        }
        return inspectOrStopService("inspect");
      });
      const execution = await executeMutableUpdate(executionParams("package"));
      expect(execution?.result.status).toBe("ok");
      expect(execution?.preManagedServiceStop?.serviceUpdateVerdict).toMatchObject({
        kind: "unavailable",
        inspectionReason: "systemd-user-bus-unavailable",
      });
      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.runPackageUpdate).toHaveBeenCalled();
    },
  );

  it.each(["available", "incompatible", "changed-owner"] as const)(
    "admits local artifacts from the staged version before rehearsal: %s",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-staged-plugin-admission-" }, async (stage) => {
        await fs.writeFile(
          path.join(stage, "package.json"),
          JSON.stringify({ name: "openclaw", version: "1.0.7" }),
        );
        const events: string[] = [];
        mocks.pluginPreflight.mockImplementation(async ({ targetVersion }) => {
          events.push("preflight");
          expect(targetVersion).toBe("1.0.7");
          expect(mocks.serviceStopped).toBe(false);
          if (outcome === "incompatible") {
            return [
              {
                pluginId: "fixture",
                reason: "Installed plugin is incompatible and its replacement is unavailable.",
                message: "Fixture plugin update needs a retry.",
                guidance: [],
              },
            ];
          }
          return [];
        });
        mocks.revalidateSchemaContext.mockImplementation(async (context) => {
          if (outcome === "changed-owner" && events.includes("preflight")) {
            throw new UpdatePreMutationError("database-schema-preflight", "fixture owner changed");
          }
          return context;
        });
        mocks.validateCanary.mockImplementation(async () => {
          events.push("rehearsal");
          return { status: "ok", phase: "readiness", steps: [], durationMs: 1, logTail: [] };
        });
        mocks.runPackageUpdate.mockImplementation(async ({ validateCandidate }) => {
          events.push("staged");
          expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
          try {
            await validateCandidate(stage);
            return successfulUpdate;
          } catch (error) {
            if (!(error instanceof UpdatePreMutationError)) {
              throw error;
            }
            return { ...successfulUpdate, status: "error", reason: "package-update-failed" };
          }
        });
        const execution = await executeMutableUpdate({
          ...executionParams("package"),
          tag: "/tmp/candidate.tgz",
          packageInstallSpec: "/tmp/candidate.tgz",
          packageTargetVersion: undefined,
        });
        expect(events).toEqual(
          outcome === "changed-owner"
            ? ["staged", "preflight"]
            : ["staged", "preflight", "rehearsal"],
        );
        expect(execution?.mutationStarted).toBe(false);
        expect(mocks.serviceStopped).toBe(false);
        expect(execution?.result.status).toBe(outcome === "changed-owner" ? "error" : "ok");
        if (outcome === "changed-owner") {
          expect(mocks.validateCanary).not.toHaveBeenCalled();
          expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
          expect(execution?.result.reason).toBe("database-schema-preflight");
        }
      });
    },
  );

  it.each(["registry", "artifact", "artifact-state-change"] as const)(
    "refuses incompatible staged %s schemas before candidate rehearsal or activation",
    async (target) => {
      await withTestDir({ prefix: "openclaw-staged-schema-admission-" }, async (stage) => {
        await fs.writeFile(
          path.join(stage, "package.json"),
          JSON.stringify({
            name: "openclaw",
            version: "2026.7.1",
            openclaw: { schemaVersions: { state: 1, agent: 1 } },
          }),
        );
        let databaseAdvanced = target !== "artifact-state-change";
        mocks.pluginPreflight.mockImplementation(async () => {
          databaseAdvanced = true;
          return [];
        });
        mocks.checkTargetSchemas.mockImplementation(async (versions) => ({
          incompatible:
            versions?.state === 1 && databaseAdvanced
              ? [
                  {
                    kind: "state",
                    path: "/fixture/default/state.sqlite",
                    foundVersion: 17,
                    supportedVersion: 1,
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
        const params = executionParams("package");
        if (target !== "registry") {
          params.tag = "/tmp/candidate.tgz";
          params.packageInstallSpec = "/tmp/candidate.tgz";
          params.packageTargetVersion = undefined;
          params.packageTargetSchemaVersions = undefined;
        }

        const execution = await executeMutableUpdate(params);

        expect(mocks.validateCanary.mock.calls.length).toBe(0);
        expect(execution).toMatchObject({
          mutationStarted: false,
          result: { status: "error", reason: "database-schema-preflight" },
        });
        expect(mocks.serviceStopped).toBe(false);
        if (target !== "registry") {
          expect(mocks.pluginPreflight).toHaveBeenCalledTimes(
            target === "artifact-state-change" ? 1 : 0,
          );
          expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each([
    { metadata: "missing", openclaw: undefined },
    { metadata: "malformed", openclaw: { schemaVersions: { state: "15", agent: 19 } } },
  ])(
    "retains registry schema admission when staged metadata is $metadata",
    async ({ openclaw }) => {
      await withTestDir({ prefix: "openclaw-staged-schema-retention-" }, async (stage) => {
        await fs.writeFile(
          path.join(stage, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.9.2", openclaw }),
        );
        let databaseAdvanced = false;
        mocks.checkTargetSchemas.mockImplementation(async (versions) => ({
          incompatible:
            databaseAdvanced && versions?.state === 15
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
          databaseAdvanced = true;
          await validateCandidate(stage);
          await beforeActivate();
          return successfulUpdate;
        });

        const execution = await executeMutableUpdate({
          ...executionParams("package"),
          tag: "2026.9.2",
          packageInstallSpec: "openclaw@2026.9.2",
          packageTargetVersion: "2026.9.2",
        });

        expect(mocks.validateCanary.mock.calls.length).toBe(0);
        expect(execution).toMatchObject({
          mutationStarted: false,
          result: { status: "error", reason: "database-schema-preflight" },
        });
        expect(mocks.serviceStopped).toBe(false);
      });
    },
  );

  it("leaves a staged local same-version no-op free of plugin or mutable preparation", async () => {
    mocks.runPackageUpdate.mockResolvedValue({
      ...successfulUpdate,
      status: "skipped",
      reason: "already-current",
    });
    const execution = await executeMutableUpdate({
      ...executionParams("package"),
      tag: "/tmp/candidate.tgz",
      packageInstallSpec: "/tmp/candidate.tgz",
      packageTargetVersion: undefined,
    });
    expect(execution?.result.reason).toBe("already-current");
    expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.pluginPreflight).not.toHaveBeenCalled();
    expect(mocks.serviceStopped).toBe(false);
  });

  it.each([
    { failure: "missing", contract: "api", range: ">=1.0.0", incompatible: false },
    { failure: "metadata", contract: "api", range: ">=1.0.0", incompatible: false },
    { failure: "throw", contract: "api", range: ">=1.0.0", incompatible: false },
    { failure: "missing", contract: "api", range: ">=1.0.0 <1.0.1", incompatible: true },
    { failure: "metadata", contract: "api", range: ">=1.0.0 <1.0.1", incompatible: true },
    { failure: "throw", contract: "api", range: ">=1.0.0 <1.0.1", incompatible: true },
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

        const execution = await executeMutableUpdate(executionParams("package"));
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
    const execution = executeMutableUpdate(executionParams("package"));
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

  it("refuses configuration drift during plugin admission before mutable preparation", async () => {
    let configChanged = false;
    mocks.pluginPreflight.mockImplementation(async () => {
      configChanged = true;
      return [];
    });
    mocks.revalidateSchemaContext.mockImplementation(async (context) => {
      if (configChanged) {
        throw new UpdatePreMutationError("database-schema-preflight", "Configuration changed");
      }
      return context;
    });

    const execution = await executeMutableUpdate(executionParams("package"));

    expect(execution?.result.reason).toBe("database-schema-preflight");
    expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
    expect(mocks.serviceStopped).toBe(false);
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });

  it("captures the package target and admitted service environment before schema awaits", async () => {
    const events: string[] = [];
    mocks.runPackageUpdate.mockImplementation(async () => {
      events.push("install");
      return successfulUpdate;
    });
    const serviceState = inspectOrStopService("inspect");
    mocks.maybeStopService.mockImplementation(async ({ phase }) => {
      if (phase === "prepare") {
        events.push("stop");
        return inspectOrStopService(phase);
      }
      return serviceState;
    });
    mocks.prepareMutableUpdate.mockImplementation(async (env) => {
      expect(env).toEqual({ OPENCLAW_PROFILE: "default" });
      events.push("mutable-prepare");
    });
    const schemaGate = createDeferred();
    mocks.checkTargetSchemas.mockImplementation(async (_versions, contexts) => {
      expect(contexts.map((context) => context.env.OPENCLAW_PROFILE)).toEqual([
        "invoker",
        "default",
      ]);
      events.push(
        events.includes("mutable-prepare") ? "schema-after-inspection" : "schema-before-inspection",
      );
      if (events.includes("mutable-prepare")) {
        await schemaGate.promise;
      }
      return { incompatible: [], indeterminate: [] };
    });

    const params = executionParams("package");
    const pendingExecution = executeMutableUpdate(params);
    try {
      await vi.waitFor(() => expect(events).toContain("schema-after-inspection"));
      expect(events.indexOf("schema-before-inspection")).toBeLessThan(
        events.indexOf("mutable-prepare"),
      );
      expect(events.at(-1)).toBe("schema-after-inspection");
      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
      params.packageInstallSpec = "openclaw@changed-during-schema-check";
      serviceState.serviceEnv = { OPENCLAW_PROFILE: "revalidated" };
    } finally {
      schemaGate.resolve();
      await pendingExecution;
    }
    const execution = await pendingExecution;

    expect(events.at(-1)).toBe("install");
    expect(mocks.prepareMutableUpdate).toHaveBeenCalledOnce();
    expect(execution?.result).toBe(successfulUpdate);
    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
    expect(mocks.runPackageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        installSpec: "openclaw@1.0.1",
        managedServiceEnv: { OPENCLAW_PROFILE: "default" },
      }),
    );
  });

  it.each(["before-prepare", "after-prepare"] as const)(
    "refuses schema mismatch at %s without invoking the package updater",
    async (phase) => {
      mocks.checkTargetSchemas.mockImplementation(async () => ({
        incompatible:
          phase === "before-prepare" || mocks.prepareMutableUpdate.mock.calls.length > 0
            ? [
                {
                  kind: "agent",
                  path: "/fixture/default/worker.sqlite",
                  foundVersion: 999,
                  supportedVersion: 19,
                },
              ]
            : [],
        indeterminate: [],
      }));

      const execution = await executeMutableUpdate(executionParams("package"));

      expect(mocks.serviceStopped).toBe(false);
      expect(mocks.prepareMutableUpdate).toHaveBeenCalledTimes(phase === "after-prepare" ? 1 : 0);
      expect(execution?.result.reason).toBe("database-schema-preflight");
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
    },
  );

  registerExecutionFailureTests();

  it.each([false, true])(
    "keeps Git activation fenced with post-stop schema drift=%s",
    async (schemaDrift) => {
      await withTestDir({ prefix: "git-selection-online-" }, async (root) => {
        const events: string[] = [];
        const target = { schemaVersions: { state: 14, agent: 18 } };
        const beginMutation = vi.fn(() => {
          expect(mocks.serviceStopped).toBe(true);
          events.push("mutation");
        });
        const onActivation = vi.fn();
        mocks.checkTargetSchemas.mockImplementation(async (versions) => {
          if (mocks.serviceStopped) {
            expect(versions).toEqual(target.schemaVersions);
            events.push("post-stop-schema");
          }
          return {
            incompatible:
              schemaDrift && mocks.serviceStopped
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
          return executeMutableUpdate(params);
        });

        expect(events).toEqual([
          "mutable-prepare",
          "git",
          "verified",
          "mutable-prepare",
          "stop",
          "post-stop-schema",
          ...(schemaDrift ? [] : ["mutation"]),
        ]);
        expect(mocks.serviceStopped).toBe(true);
        expect(beginMutation).toHaveBeenCalledTimes(schemaDrift ? 0 : 1);
        expect(onActivation).toHaveBeenCalledTimes(schemaDrift ? 0 : 1);
        expect(execution?.mutationStarted).toBe(!schemaDrift);
        expect(execution?.result.status, JSON.stringify(execution?.failure)).toBe(
          schemaDrift ? "error" : "ok",
        );
        if (schemaDrift) {
          expect(execution?.result.reason).toBe("database-schema-preflight");
        }
        expect(execution?.result.mode).toBe("git");
        expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
      });
    },
  );
});
