import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

const mocks = vi.hoisted(() => ({
  captureManagedContext: vi.fn(),
  captureManagedPreflight:
    vi.fn<
      typeof import("./update-command-managed-context.js").captureOwnedManagedUpdatePreflightContext
    >(),
  captureSchemaContext:
    vi.fn<typeof import("./schema-preflight.js").captureTargetDatabaseSchemaContext>(),
  checkTargetSchemas:
    vi.fn<typeof import("./schema-preflight.js").checkTargetDatabaseSchemasForContexts>(),
  formatSchemaRefusalLines: vi.fn(),
  hasSchemaRefusal: vi.fn(),
  maybeRestartService: vi.fn(),
  maybeStopService: vi.fn(),
  prepareMutableUpdate: vi.fn<(env?: NodeJS.ProcessEnv) => Promise<void>>(),
  pluginPreflight: vi.fn(),
  pluginTargets: vi.fn(),
  pluginRecords: vi.fn(),
  npmMetadata: vi.fn(),
  readGitRecovery: vi.fn(),
  runGitUpdate: vi.fn(),
  runPackageUpdate: vi.fn(),
  runtimeError: vi.fn(),
  repair: vi.fn(),
  revalidateSchemaContext:
    vi.fn<typeof import("./update-command-managed-context.js").revalidateUpdateDatabaseContext>(),
  validateCanary: vi.fn(),
  nativeSupport:
    vi.fn<
      typeof import("./update-command-service-command.js").isUpdatedInstallGatewayExecutorSupported
    >(),
  serviceStopped: false,
  shouldBlockServiceUpdate: vi.fn(),
  verifyPackageRecovery: vi.fn(),
}));

vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  isUpdatedInstallGatewayExecutorSupported: mocks.nativeSupport,
}));

afterEach(() => vi.restoreAllMocks());
vi.mock("./update-command-repair.js", () => ({ runUpdateCommandRepair: mocks.repair }));

vi.mock("../../infra/update-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-global.js")>()),
  verifyPackageUpdateRecovery: mocks.verifyPackageRecovery,
}));
vi.mock("../../infra/update-candidate-canary.js", () => ({
  validateUpdateCandidateCanary: mocks.validateCanary,
}));

vi.mock("./update-command-plugin-preflight.js", () => ({
  preflightConfiguredNpmPluginTargets: mocks.pluginPreflight,
}));

vi.mock("../../commands/doctor/shared/missing-configured-plugin-install.targets.js", () => ({
  collectConfiguredNpmPluginTargets: mocks.pluginTargets,
}));
vi.mock("../../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: mocks.pluginRecords,
}));
vi.mock("../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.npmMetadata,
}));

vi.mock("../../infra/update-runner-git-recovery.js", () => ({
  readCurrentGitUpdateRecovery: mocks.readGitRecovery,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: mocks.runtimeError },
}));

vi.mock("./schema-preflight.js", () => ({
  captureTargetDatabaseSchemaContext: mocks.captureSchemaContext,
  checkTargetDatabaseSchemasForContexts: mocks.checkTargetSchemas,
  formatSchemaRefusalLines: mocks.formatSchemaRefusalLines,
  hasSchemaRefusal: mocks.hasSchemaRefusal,
}));

vi.mock("./update-command-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-git.js")>()),
  updateGitInstall: mocks.runGitUpdate,
}));

vi.mock("./update-command-handoff.js", () => ({
  formatUpdateAncestryBlockMessage: (message: string) => message,
  handoffUpdateFromGateway: vi.fn(),
}));

vi.mock("./update-command-managed-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-managed-context.js")>()),
  captureOwnedManagedUpdateContext: mocks.captureManagedContext,
  captureOwnedManagedUpdatePreflightContext: mocks.captureManagedPreflight,
  revalidateUpdateDatabaseContext: mocks.revalidateSchemaContext,
}));

vi.mock("./update-command-package.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-package.js")>()),
  runPackageInstallUpdate: mocks.runPackageUpdate,
}));

vi.mock("./update-command-service.js", async () => {
  const actual = await vi.importActual<typeof import("./update-command-service-maintenance.js")>(
    "./update-command-service-maintenance.js",
  );
  return {
    maybeRestartServiceAfterFailedMutableUpdate: mocks.maybeRestartService,
    maybeStopManagedServiceBeforeMutableUpdate: mocks.maybeStopService,
    shouldBlockMutableUpdateFromGatewayServiceEnv: mocks.shouldBlockServiceUpdate,
    UpdateCommandAbort: actual.UpdateCommandAbort,
  };
});

import { UpdatePreMutationError } from "./shared.js";
import { executeMutableUpdate } from "./update-command-execution.js";

const successfulUpdate: UpdateRunResult = {
  status: "ok",
  mode: "npm",
  root: "/opt/openclaw",
  before: { version: "1.0.0" },
  after: { version: "1.0.1" },
  steps: [],
  durationMs: 1,
};

function executionParams(
  updateInstallKind: "git" | "package",
): Parameters<typeof executeMutableUpdate>[0] {
  return {
    root: "/opt/openclaw",
    installKind: updateInstallKind,
    updateInstallKind,
    switchToGit: false,
    timeoutMs: 30_000,
    updateStepTimeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    stop: vi.fn(),
    channel: "stable",
    tag: "1.0.1",
    opts: { json: true },
    shouldRestart: true,
    packageInstallSpec: "openclaw@1.0.1",
    packageTargetVersion: "1.0.1",
    managedServiceRootRedirect: null,
    invocationCwd: "/work",
    recoveryState: { triageTarget: { env: {} } },
    prepareMutableUpdate: mocks.prepareMutableUpdate,
    packageTargetSchemaVersions: { state: 15, agent: 19 },
  };
}

function schemaContext(
  profile: string,
): Awaited<ReturnType<typeof captureTargetDatabaseSchemaContext>> {
  const env = { OPENCLAW_PROFILE: profile };
  return {
    env,
    readEnv: { ...env },
    config: {},
    configSnapshot: {
      path: `/fixture/${profile}/openclaw.json`,
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      valid: true,
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
  };
}

function inspectOrStopService(phase: "inspect" | "prepare" = "prepare"): PreManagedServiceStop {
  const running = !mocks.serviceStopped;
  if (phase === "prepare") {
    mocks.serviceStopped = true;
  }
  return {
    stopped: phase === "prepare",
    inspected: true,
    runtimeInspected: true,
    running,
    serviceEnv: { OPENCLAW_PROFILE: "default" },
    serviceUpdateVerdict: {
      kind: "owned",
      root: "/opt/openclaw",
      fingerprint: "service-fingerprint",
      refreshDefinition: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serviceStopped = false;
  mocks.repair.mockResolvedValue({ status: "unavailable", reason: "No inference configured." });
  mocks.validateCanary.mockResolvedValue({
    status: "ok",
    phase: "readiness",
    steps: [],
    durationMs: 1,
    logTail: [],
  });
  mocks.captureManagedContext.mockResolvedValue(undefined);
  mocks.captureManagedPreflight.mockResolvedValue(schemaContext("default"));
  mocks.captureSchemaContext.mockResolvedValue(schemaContext("invoker"));
  mocks.revalidateSchemaContext.mockImplementation(async (context) => context);
  mocks.checkTargetSchemas.mockResolvedValue({ incompatible: [], indeterminate: [] });
  mocks.formatSchemaRefusalLines.mockReturnValue(["schema refused"]);
  mocks.hasSchemaRefusal.mockImplementation(
    (schemas) => schemas.incompatible.length > 0 || schemas.indeterminate.length > 0,
  );
  mocks.maybeRestartService.mockResolvedValue(undefined);
  mocks.maybeStopService.mockImplementation(async ({ phase }) => inspectOrStopService(phase));
  mocks.prepareMutableUpdate.mockResolvedValue(undefined);
  mocks.pluginPreflight.mockResolvedValue([]);
  mocks.readGitRecovery.mockResolvedValue({ serviceRestartSafe: true });
  mocks.runGitUpdate.mockResolvedValue({ ...successfulUpdate, mode: "git" });
  mocks.runPackageUpdate.mockResolvedValue(successfulUpdate);
  mocks.shouldBlockServiceUpdate.mockReturnValue(false);
  mocks.verifyPackageRecovery.mockResolvedValue({ serviceRestartSafe: true });
});

describe("mutable update execution", () => {
  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [30_000, 600_000].map((timeoutMs) => ({ kind, timeoutMs })),
    ),
  )(
    "passes the configured $timeoutMs ms step budget to $kind candidate validation",
    async ({ kind, timeoutMs }) => {
      const runStagedUpdate = async ({
        validateCandidate,
      }: {
        validateCandidate?: (root: string) => Promise<unknown>;
      }) => {
        expect(validateCandidate).toBeTypeOf("function");
        await validateCandidate?.("/candidate");
        return successfulUpdate;
      };
      mocks.runPackageUpdate.mockImplementation(runStagedUpdate);
      mocks.runGitUpdate.mockImplementation(runStagedUpdate);

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        timeoutMs,
        updateStepTimeoutMs: timeoutMs,
      });

      expect(execution?.result.status).toBe("ok");
      expect(mocks.validateCanary).toHaveBeenCalledOnce();
      expect(mocks.validateCanary.mock.calls[0]?.[0].root).toBe("/candidate");
      expect(mocks.validateCanary.mock.calls[0]?.[0].timeoutMs).toBe(timeoutMs);
    },
  );

  it.each(["package", "staged", "git"] as const)(
    "refuses an unsupported native receiver before activation: %s",
    async (route) =>
      withTestDir({ prefix: "native-before-activation-" }, async (dir) => {
        const control = path.join(dir, "leases");
        await fs.mkdir(control);
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const env = { OPENCLAW_STATE_DIR: dir };
        const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
        const params = executionParams(route === "git" ? "git" : "package");
        params.root = dir;
        params.opts.run = { runId, env };
        if (route === "staged") {
          params.packageInstallSpec = path.join(dir, "candidate.tgz");
        }
        const events: string[] = [];
        mocks.nativeSupport.mockImplementation(async ({ executor }) => {
          executor.assertCurrent();
          events.push("native-admission");
          return false;
        });
        const candidate = async ({
          validateCandidate,
        }: {
          validateCandidate: (root: string) => Promise<unknown>;
        }) => {
          await validateCandidate(dir);
          // Models the package/Git publisher which follows successful validation.
          events.push("publish");
          return successfulUpdate;
        };
        mocks.runPackageUpdate.mockImplementation(candidate);
        mocks.runGitUpdate.mockImplementation(
          async (
            options: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
          ) => {
            if (!options.inspectGitTarget || !options.validateCandidate) {
              throw new Error("Missing actual Git admission callbacks");
            }
            await options.inspectGitTarget({ schemaVersions: { state: 15, agent: 19 } });
            return candidate({ validateCandidate: options.validateCandidate });
          },
        );
        const result = await withUpdateCommandExecutor(runId, async (executor) => {
          mocks.prepareMutableUpdate.mockImplementation(async () => {
            params.opts.run!.executorFence = await executor.enter(dir);
          });
          return executeMutableUpdate(params);
        });
        expect(result?.result).toMatchObject({
          status: "error",
          reason: "target-native-unsupported",
        });
        expect(events).toEqual(["native-admission"]);
        expect(mocks.serviceStopped).toBe(false);
        expect(mocks.validateCanary).not.toHaveBeenCalled();
      }),
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

  it("reports activation exceptions without retrying a fallback package updater", async () => {
    const failure = new Error("activation failed");
    mocks.runPackageUpdate.mockRejectedValue(failure);

    const execution = await executeMutableUpdate(executionParams("package"));

    expect(mocks.runPackageUpdate).toHaveBeenCalledOnce();
    expect(execution?.failure?.cause).toBe(failure);
    expect(execution?.result).toMatchObject({
      status: "error",
      reason: "update-failed",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    });
  });

  it("reports a failed Git update check once and keeps its actual diagnosis in the result", async () => {
    const onStepComplete = vi.fn();
    const failed = {
      name: "Checking update health",
      command: "doctor --lint --json",
      cwd: "/opt/update",
      durationMs: 10,
      exitCode: 1,
      failureSummary: "Configured plugin is unavailable.",
      stderrTail: "raw diagnostic block that must not be replayed",
    };
    mocks.validateCanary.mockImplementation(async ({ onStep }) => {
      onStep(failed);
      return {
        status: "error",
        reason: "doctor-failed",
        phase: "health",
        steps: [failed],
        durationMs: 10,
        logTail: [failed.stderrTail],
      };
    });
    mocks.runGitUpdate.mockImplementation(async (params) => {
      await params.validateCandidate("/opt/update");
      throw new Error("A failed update must not reach activation");
    });
    const execution = await executeMutableUpdate({
      ...executionParams("git"),
      progress: { onStepComplete },
    });
    expect(onStepComplete).toHaveBeenCalledOnce();
    expect(mocks.runtimeError).not.toHaveBeenCalled();
    expect(execution?.result).toMatchObject({ status: "error", reason: "doctor-failed" });
    expect(execution?.result.steps[0]?.stderrTail).toBe("Configured plugin is unavailable.");
    expect(mocks.serviceStopped).toBe(false);
  });

  it("keeps Git candidate selection online and delegates its later activation", async () => {
    const events: string[] = [];
    mocks.maybeStopService.mockImplementation(async ({ phase }) => {
      if (phase === "prepare") {
        events.push("stop");
      }
      return inspectOrStopService(phase);
    });
    mocks.prepareMutableUpdate.mockImplementation(async () => {
      events.push("mutable-prepare");
    });
    mocks.runGitUpdate.mockImplementation(
      async (params: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0]) => {
        if (!params.inspectGitTarget || !params.beforeGitMutation) {
          throw new Error("Expected both real Git admission callbacks");
        }
        const target = { schemaVersions: { state: 15, agent: 19 } };
        await params.inspectGitTarget(target);
        events.push("git");
        return { ...successfulUpdate, mode: "git" };
      },
    );

    const execution = await executeMutableUpdate(executionParams("git"));

    expect(events).toEqual(["mutable-prepare", "git"]);
    expect(mocks.serviceStopped).toBe(false);
    expect(execution?.result.mode).toBe("git");
    expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
  });
});
