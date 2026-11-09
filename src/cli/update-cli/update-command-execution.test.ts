// Install the fixture mocks before loading the execution owner and its dependencies.
import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { registerExecutionFailureTests } from "./update-command-execution-failures.test-support.js";
import { registerNativeAdmissionTests } from "./update-command-execution-native-admission.test-support.js";
import { registerExecutionTimeoutTests } from "./update-command-execution-timeouts.test-support.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { updateGitInstall } from "./update-command-git.js";
import { updateStep } from "./update-command-maintenance-fixtures.test-support.js";
import type { PackageInstallUpdateParams } from "./update-command-package.js";
import * as readiness from "./update-command-readiness.js";
import { registerServiceCollectionTests } from "./update-command-service-collection.test-support.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

const {
  bindExecutionGuards,
  executionParams,
  inspectOrStopService,
  mocks,
  packageCandidate,
  successfulUpdate,
} = await import("./update-command-execution.test-support.js");

async function execute(params = executionParams("package")) {
  return executeMutableUpdate(await bindExecutionGuards(params));
}

function schemaRefusal(supportedVersion: number): OpenClawDatabaseSchemaPreflight {
  return {
    incompatible: [
      {
        kind: "state",
        path: "/fixture/default/state.sqlite",
        foundVersion: 17,
        supportedVersion,
      },
    ],
    indeterminate: [],
  };
}

function expectNoPackageMutation() {
  expect(mocks.serviceStopped).toBe(false);
  expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
  expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
}

function serviceState(
  root: string,
  phase: "inspect" | "prepare" = "prepare",
  fingerprint = "service-fingerprint",
): PreManagedServiceStop {
  return {
    ...inspectOrStopService(phase),
    serviceUpdateVerdict: { kind: "owned", root, fingerprint, refreshDefinition: false },
  };
}

async function runParams(root: string, kind: "package" | "git", state = root) {
  const control = path.join(root, "leases");
  await fs.mkdir(control);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const env = { OPENCLAW_STATE_DIR: state };
  const params = { ...executionParams(kind), root };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
  };
  return { ...params, opts: { ...params.opts, run } };
}

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
      const deferred = updateStep("post-install-verify", {
        command: "verify installed package",
        cwd: options.root,
        exitCode: outcome === "advisory" ? 0 : null,
        durationMs: 0,
        advisory: {
          kind: "recoverable-maintenance" as const,
          message: "State verification deferred to the operator restart.",
        },
      });
      const install = kind === "package" ? mocks.runPackageUpdate : mocks.runGitUpdate;
      const result = {
        ...successfulUpdate,
        ...(outcome === "failure" ? { status: "error", reason: "post-update-failed" } : {}),
        steps: [deferred],
      };
      install.mockResolvedValueOnce(result);
      const execution = await execute(options);
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

  registerNativeAdmissionTests();
  it.each(["same", "alias", "disjoint", "unmanaged", "foreign", "unverifiable"] as const)(
    "preserves managed refusals and warns for unowned Git consumers: %s",
    async (destination) =>
      withTestDir({ prefix: "git-live-runtime-custody-" }, async (dir) => {
        const servingRoot = path.join(dir, "serving");
        const warn = ["unmanaged", "foreign", "unverifiable"].includes(destination);
        const targetRoot = destination === "same" || warn ? servingRoot : path.join(dir, "target");
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
        const targetArtifact = path.join(targetRoot, "dist", "prepare.runtime.js");
        await fs.writeFile(artifact, "retained serving runtime");
        const target = { schemaVersions: { state: 15, agent: 19 } };
        const state = serviceState(servingRoot, "inspect", "serving-generation");
        if (warn) {
          state.serviceUpdateVerdict = destination === "foreign" ? { kind: "foreign" } : undefined;
        }
        mocks.maybeStopService.mockResolvedValue({ ...state, servicePid: 23456 });
        const owner = warn ? { pid: process.pid, createdAt: "now", port: 20445 } : undefined;
        const readOwner = vi
          .spyOn(gatewayLock, "readActiveGatewayLockIdentity")
          .mockResolvedValue(owner);
        if (destination === "unverifiable") {
          readOwner.mockRejectedValue(new Error("owner inspection unavailable"));
        }
        mocks.runGitUpdate.mockImplementation(
          async (options: Parameters<typeof updateGitInstall>[0]) => {
            await options.inspectGitTarget?.(target);
            await options.beforeGitMutation?.(target);
            await fs.writeFile(targetArtifact, "candidate runtime");
            return { ...successfulUpdate, mode: "git" };
          },
        );
        const execution = await execute({
          ...executionParams("git"),
          root: targetRoot,
          shouldRestart: warn,
          opts: { json: true, restart: warn },
        });
        expect(await fs.readFile(artifact, "utf8")).toBe(
          warn ? "candidate runtime" : "retained serving runtime",
        );
        const blocked = !warn && destination !== "disjoint";
        expect(execution?.mutationStarted).toBe(!blocked);
        expect(execution?.result.status).toBe(blocked ? "error" : "ok");
        expect(execution?.result.reason).toBe(blocked ? "runtime-artifact-publication" : undefined);
        const diagnostics = (execution?.result.steps ?? [])
          .map((step) => step.advisory?.message ?? step.stderrTail ?? "")
          .join("");
        expect(diagnostics).toMatch(warn ? /previous runtime/ : blocked ? /23456/ : /^$/);
      }),
  );
  it("retains the live update run when stopped-service context capture fails", async () => {
    await withTestDir({ prefix: "partial-stop-recovery-owner-" }, async (dir) => {
      const params = await runParams(dir, "package");
      const { runId, env } = params.opts.run;
      mocks.maybeStopService.mockImplementation(async () => ({
        ...serviceState(dir, "prepare", "original"),
        serviceEnv: env,
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
        params.opts.run.executorFence = await executor.enter(dir, { preflight: true });
        const result = await execute(params);
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
    expect(await execute()).toMatchObject({
      mutationStarted: false,
      result: { status: "error", reason: "managed-service-preflight" },
    });
    expectNoPackageMutation();
  });

  it("admits FreeBSD packages with a service advisory and no restart", async () =>
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

        const execution = await execute({
          ...executionParams("package"),
          shouldRestart: false,
          opts: { json: true, restart: false },
        });

        expect(execution?.result.status).toBe("ok");
        expect(execution?.preManagedServiceStop).toMatchObject({
          serviceMutationAllowed: false,
          serviceUpdateVerdict: { kind: "unavailable" },
          serviceMutationSkipMessage: expect.stringContaining("rc.d or foreground process owner"),
        });
        expect(execution?.preManagedServiceStop?.serviceMutationSkipMessage).toContain(
          "openclaw gateway stop",
        );
        expect(mocks.serviceStopped).toBe(false);
        expect(mocks.runPackageUpdate).toHaveBeenCalled();
      },
    ));

  it("retains registry schema admission when staged metadata is missing", async () => {
    await withTestDir({ prefix: "openclaw-staged-schema-retention-" }, async (stage) => {
      await writeFixtureJson(path.join(stage, "package.json"), {
        name: "openclaw",
        version: "2026.9.2",
      });
      mocks.checkTargetSchemas.mockImplementation(async (versions) =>
        versions?.state === 15 ? schemaRefusal(15) : { incompatible: [], indeterminate: [] },
      );
      mocks.runPackageUpdate.mockImplementation(packageCandidate(stage));

      const execution = await execute({
        ...executionParams("package"),
        tag: "2026.9.2",
        packageInstallSpec: "openclaw@2026.9.2",
        packageTargetVersion: "2026.9.2",
      });

      expect(mocks.validateCanary).toHaveBeenCalledOnce();
      expect(execution).toMatchObject({
        mutationStarted: false,
        result: { status: "error", reason: "database-schema-preflight" },
      });
      expect(mocks.serviceStopped).toBe(false);
    });
  });

  it.each([false, true])(
    "keeps plugin availability advisory (incompatible=%s)",
    async (incompatible) =>
      withTestDir({ prefix: "plugin-admission-" }, async (installPath) => {
        await writeFixtureJson(path.join(installPath, "package.json"), {
          name: "@example/demo",
          version: "1.0.0",
          openclaw: incompatible
            ? { install: { minHostVersion: ">=1.0.2" } }
            : { compat: { pluginApi: ">=1.0.0" } },
        });
        mocks.pluginRecords.mockResolvedValue({
          demo: { source: "npm", spec: "@example/demo@1.0.1", version: "1.0.0", installPath },
        });
        mocks.pluginTargets.mockResolvedValue([{ pluginId: "demo", spec: "@example/demo@1.0.1" }]);
        mocks.npmMetadata.mockResolvedValue({
          ok: false,
          category: "metadata-env",
          error: "ECONNRESET",
        });
        const actual = await vi.importActual<typeof import("./update-command-plugin-preflight.js")>(
          "./update-command-plugin-preflight.js",
        );
        mocks.pluginPreflight.mockImplementation(actual.preflightConfiguredNpmPluginTargets);
        expect((await execute())?.result.status).toBe("ok");
        expect(mocks.serviceStopped).toBe(false);
        expect(mocks.npmMetadata).toHaveBeenCalledTimes(incompatible ? 1 : 0);
        const warnings = await mocks.pluginPreflight.mock.results[0]?.value;
        if (incompatible) {
          expect(warnings).toMatchObject([
            {
              pluginId: "demo",
              reason: expect.stringContaining("registry could not be reached: ECONNRESET"),
            },
          ]);
          expect(mocks.runtimeError).toHaveBeenCalledWith(warnings[0].message);
        } else {
          expect(warnings).toEqual([]);
        }
      }),
  );

  it("preserves a plugin preflight failure before mutation", async () => {
    const failure = new Error("registry connection failed");
    mocks.pluginPreflight.mockRejectedValueOnce(failure);
    const execution = await execute();
    expect(execution?.result).toMatchObject({ status: "error", reason: "update-failed" });
    expect(execution?.failure?.cause).toBe(failure);
    expectNoPackageMutation();
  });

  it("waits for plugin availability before preparing a package update", async () => {
    const available = createDeferred<[]>();
    mocks.pluginPreflight.mockImplementation(() => available.promise);
    const execution = executeMutableUpdate(await bindExecutionGuards(executionParams("package")));
    try {
      await vi.waitFor(() => expect(mocks.pluginPreflight).toHaveBeenCalledOnce());
      expectNoPackageMutation();
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
          return incompatible ? schemaRefusal(14) : { incompatible: [], indeterminate: [] };
        });
        mocks.maybeStopService.mockImplementation(async ({ phase }) => {
          if (phase === "prepare") {
            events.push("stop");
          }
          const state = serviceState(root, phase);
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
        // The predecessor-readiness suite owns real HTTP probes; this case owns activation order.
        vi.spyOn(readiness, "verifyPreviousGatewayForUpdate").mockImplementation(
          async ({ assertCurrent }) => {
            assertCurrent?.();
            expect(mocks.serviceStopped).toBe(false);
            events.push("verified");
            return true;
          },
        );
        mocks.runGitUpdate.mockImplementation(
          async (params: Parameters<typeof updateGitInstall>[0]) => {
            await params.inspectGitTarget(target);
            events.push("git");
            expect(mocks.serviceStopped).toBe(false);
            await params.beforeGitMutation(target);
            return { ...successfulUpdate, mode: "git" };
          },
        );

        const params = {
          ...(await runParams(root, "git", path.join(root, "state"))),
          onActivation,
        };
        const execution = await withUpdateCommandExecutor(
          params.opts.run.runId,
          async (executor) => {
            mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
              events.push("mutable-prepare");
              admitExecutor(await executor.enter(root));
            });
            return execute(params);
          },
        );

        expect(events).toEqual([
          "mutable-prepare",
          "git",
          "activation-schema",
          ...(incompatible ? [] : ["verified", "mutable-prepare", "stop", "mutation"]),
        ]);
        expect(execution?.previousVerified).toBe(!incompatible);
        expect(onActivation).toHaveBeenCalledTimes(incompatible ? 0 : 1);
        expect(execution, JSON.stringify(execution?.failure)).toMatchObject({
          mutationStarted: !incompatible,
          result: { status: incompatible ? "error" : "ok", mode: "git" },
        });
        if (incompatible) {
          expect(execution?.result.reason).toBe("database-schema-preflight");
        }
        expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
      });
    },
  );

  it.each(
    (["git", "package"] as const).flatMap((kind) =>
      (["postgres-held", "postgres-free", "sqlite-held"] as const).map((scenario) => ({
        kind,
        scenario,
      })),
    ),
  )(
    "settles PostgreSQL capture ownership before replacing a $kind install ($scenario)",
    async ({ kind, scenario }) =>
      withTestDir({ prefix: "postgres-capture-ownership-" }, async (root) => {
        const refused = scenario === "postgres-held";
        const params = await runParams(root, kind);
        const { env } = params.opts.run;
        await writeFixtureJson(path.join(root, "openclaw.json"), {
          database: {
            engine: scenario === "sqlite-held" ? "sqlite" : "postgres",
            postgres: { connection: "postgresql://synthetic.invalid/update-capture" },
          },
        });
        // Only the stopped control lets the updater release the simulated Gateway owner.
        mocks.maybeStopService.mockImplementation(async ({ phase }) => ({
          ...inspectOrStopService(scenario === "postgres-free" ? phase : "inspect"),
          running: false,
          serviceEnv: env,
          serviceUpdateVerdict: { kind: "absent" },
        }));
        const acquire = gatewayLock.acquireGatewayLock;
        vi.spyOn(gatewayLock, "acquireGatewayLock").mockImplementation(async (options) =>
          scenario !== "postgres-free" && options?.role === "sqlite-maintenance"
            ? null
            : acquire(options),
        );
        const events: string[] = [];
        const target = { schemaVersions: { state: 15, agent: 19 } };
        mocks.runGitUpdate.mockImplementation(
          async (options: Parameters<typeof updateGitInstall>[0]) => {
            await options.inspectGitTarget(target);
            await options.beforeGitMutation(target);
            events.push("install-replaced");
            return { ...successfulUpdate, mode: "git" };
          },
        );
        mocks.runPackageUpdate.mockImplementation(async (options: PackageInstallUpdateParams) => {
          await options.validateCandidate(root);
          await options.beforeActivate();
          events.push("install-replaced");
          return successfulUpdate;
        });
        const execution = await withUpdateCommandExecutor(
          params.opts.run.runId,
          async (executor) => {
            params.opts.run.executorFence = await executor.enter(root);
            return execute(params);
          },
        );

        expect(mocks.serviceStopped).toBe(scenario === "postgres-free");
        expect(events).toEqual(refused ? [] : ["install-replaced"]);
        expect(execution, JSON.stringify(execution?.failure)).toMatchObject({
          mutationStarted: !refused,
          result: refused
            ? { status: "error", reason: "database-engine-preflight" }
            : { status: "ok" },
        });
        if (refused) {
          expect(execution?.failure?.detail).toContain("exclusive state ownership");
          expect(execution?.failure?.detail).toMatch(/Stop the Gateway through its service owner/);
        }
      }),
  );

  it.each(["git", "package"] as const)(
    "refuses a held PostgreSQL owner before candidate validation of a %s install",
    async (kind) =>
      withTestDir({ prefix: "postgres-capture-early-" }, async (root) => {
        const params = await runParams(root, kind);
        const { env } = params.opts.run;
        await writeFixtureJson(path.join(root, "openclaw.json"), {
          database: {
            engine: "postgres",
            postgres: { connection: "postgresql://synthetic.invalid/update-capture" },
          },
        });
        // A foreign or absent service is never stopped by the updater.
        mocks.maybeStopService.mockImplementation(async () => ({
          ...inspectOrStopService("inspect"),
          running: false,
          serviceEnv: env,
          serviceUpdateVerdict: { kind: "absent" },
        }));
        const acquire = gatewayLock.acquireGatewayLock;
        vi.spyOn(gatewayLock, "acquireGatewayLock").mockImplementation(async (options) =>
          options?.role === "sqlite-maintenance" ? null : acquire(options),
        );
        const events: string[] = [];
        let refusal = "";
        mocks.runGitUpdate.mockImplementation(
          async (options: Parameters<typeof updateGitInstall>[0]) => {
            await options.inspectGitTarget({ schemaVersions: { state: 15, agent: 19 } });
            await options.validateCandidate!(root);
            events.push("validated");
            return { ...successfulUpdate, mode: "git" };
          },
        );
        // The package runner reports a thrown validation error as its own failed step.
        mocks.runPackageUpdate.mockImplementation(async (options: PackageInstallUpdateParams) => {
          try {
            await options.validateCandidate(root);
          } catch (error) {
            refusal = String(error);
            return { ...successfulUpdate, status: "error", reason: "global-install-failed" };
          }
          events.push("validated");
          return successfulUpdate;
        });
        const execution = await withUpdateCommandExecutor(
          params.opts.run.runId,
          async (executor) => {
            params.opts.run.executorFence = await executor.enter(root);
            return execute(params);
          },
        );

        expect(mocks.validateCanary).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect(execution, JSON.stringify(execution?.failure)).toMatchObject({
          mutationStarted: false,
          result: { status: "error", reason: "database-engine-preflight" },
        });
        expect(kind === "git" ? execution?.failure?.detail : refusal).toContain(
          "exclusive state ownership",
        );
      }),
  );

  it.each(["owned", "unresolved"] as const)(
    "keeps candidate validation when a running %s service will release the owner",
    async (verdict) =>
      withTestDir({ prefix: "postgres-capture-managed-" }, async (root) => {
        // The restart executor check is covered elsewhere; this case owns validation order.
        const params = { ...(await runParams(root, "package")), shouldRestart: false };
        const { env } = params.opts.run;
        await writeFixtureJson(path.join(root, "openclaw.json"), {
          database: {
            engine: "postgres",
            postgres: { connection: "postgresql://synthetic.invalid/update-capture" },
          },
        });
        mocks.maybeStopService.mockImplementation(async ({ phase }) => {
          const state = { ...inspectOrStopService(phase), serviceEnv: env };
          if (verdict === "unresolved") {
            state.serviceUpdateVerdict = { kind: "unresolved", root, fingerprint: "fixture" };
          }
          return state;
        });
        const acquire = gatewayLock.acquireGatewayLock;
        vi.spyOn(gatewayLock, "acquireGatewayLock").mockImplementation(async (options) =>
          options?.role === "sqlite-maintenance" && !mocks.serviceStopped ? null : acquire(options),
        );
        const events: string[] = [];
        mocks.runPackageUpdate.mockImplementation(async (options: PackageInstallUpdateParams) => {
          await options.validateCandidate(root);
          events.push("validated");
          return successfulUpdate;
        });
        const execution = await withUpdateCommandExecutor(
          params.opts.run.runId,
          async (executor) => {
            params.opts.run.executorFence = await executor.enter(root);
            return execute(params);
          },
        );

        expect(events, JSON.stringify(execution?.failure)).toEqual(["validated"]);
        expect(execution?.result.reason).not.toBe("database-engine-preflight");
      }),
  );
});
