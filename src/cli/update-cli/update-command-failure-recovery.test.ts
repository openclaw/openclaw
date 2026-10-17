import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gatewayService from "../../daemon/service.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import * as ports from "../../infra/ports-inspect.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import * as utils from "../../utils.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import {
  finishSuccessfulPackageSwitch,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandFailure as ReportedUpdateCommandFailure } from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";

const mocks = vi.hoisted(() => ({
  activePort: vi.fn<typeof import("../../infra/gateway-lock.js").readActiveGatewayLockPort>(
    async () => undefined,
  ),
  managedService: vi.fn<
    typeof import("./update-command-service-plan.js").readManagedGatewayServiceForUpdate
  >(async () => null),
  converge: vi.fn<typeof import("./update-command-convergence.js").convergeUpdatePlugins>(),
  printResult: vi.fn(),
}));
vi.mock("./update-command-convergence.js", () => ({ convergeUpdatePlugins: mocks.converge }));
vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: mocks.activePort,
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  readManagedGatewayServiceForUpdate: mocks.managedService,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
const containing = (value: unknown) => expect.objectContaining(value);
const noCalls = (...fns: unknown[]) => {
  for (const fn of fns) {
    expect(fn).not.toHaveBeenCalled();
  }
};
const failedPlugins = (recovery?: {
  serviceRestartSafe: false;
  reason: "state-migration-started";
}) =>
  mocks.converge.mockImplementationOnce(async ({ result }) => ({
    resultWithPostUpdate: {
      ...result,
      status: "error",
      reason: "post-update-plugins",
      ...(recovery && { recovery }),
    },
  }));
function mockService(
  readRuntime: ReturnType<typeof gatewayService.resolveGatewayService>["readRuntime"],
) {
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
    ...gatewayService.resolveGatewayService(),
    readRuntime,
    readCommand: vi.fn(async () => null),
    isLoaded: vi.fn(async () => false),
  });
}
function mockFreePort() {
  return vi.spyOn(ports, "inspectPortUsage").mockImplementation(async (port) => ({
    port,
    status: "free",
    listeners: [],
    hints: [],
  }));
}
async function useRealVerification() {
  const actual = await vi.importActual<typeof import("./update-command-verification.js")>(
    "./update-command-verification.js",
  );
  vi.mocked(verifyUpdatedGateway).mockImplementationOnce(actual.verifyUpdatedGateway);
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.activePort.mockReset();
  mocks.managedService.mockReset();
  vi.mocked(verifyUpdatedGateway)
    .mockReset()
    .mockResolvedValue({ ok: false, score: 0, summary: "stopped-free" });
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("failure-recovery-state-"));
  root = dirs.make("failure-recovery-package-");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
  );
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("settles a headless package rollback without waiting for a Gateway", async () => {
  const { packageRoot, transaction } = await createRetainedPackageSwap(root);
  const configPath = path.join(process.env.OPENCLAW_STATE_DIR!, "openclaw.json");
  const declaration = runtimeProcessEntrypoints.updateCandidateState;
  const worker = path.join(packageRoot, "dist", declaration.distWorkerPath);
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(
    worker,
    `import ${JSON.stringify(resolveRuntimeWorkerUrl(declaration).href)};\n`,
  );
  const schemaVersions = await readUpdateStateSchemaVersions({
    stateDir: process.env.OPENCLAW_STATE_DIR!,
    config: {},
    env: process.env,
  });
  const readRuntime = vi.fn(async () => ({ status: "stopped", missingUnit: true }));
  mockService(readRuntime);
  const inspect = mockFreePort();
  const sleep = vi.spyOn(utils, "sleep").mockImplementation(async () => {
    throw new Error("Headless recovery must not wait for Gateway startup");
  });
  await useRealVerification();
  failedPlugins();
  const failure = await finishSuccessfulPackageSwitch(
    { packageRoot, json: true },
    {
      opts: { json: true, restart: false },
      shouldRestart: false,
      packageTransaction: transaction,
      rollbackBlockedReason: undefined,
      schemaVersions,
      configSnapshot: {
        ...validConfigSnapshot,
        path: configPath,
        exists: false,
        raw: null,
        resolved: {},
      },
      preManagedServiceStop: {
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running: false,
        serviceMutationAllowed: false,
        serviceUpdateVerdict: { kind: "absent" },
      },
      result: {
        status: "ok",
        mode: "npm",
        root: packageRoot,
        before: { version: "1.0.0" },
        after: { version: "2.0.0" },
        steps: [],
        durationMs: 1,
      },
    },
  ).catch((error: unknown) => error);
  if (!(failure instanceof ReportedUpdateCommandFailure)) {
    throw failure;
  }
  expect(failure).toMatchObject({
    name: "UpdateCommandFailure",
    result: {
      status: "error",
      reason: "post-update-plugins",
      rollbackOutcome: { status: "succeeded" },
      recovery: { packageRollbackVerified: true },
    },
  });
  await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
    '"version":"1.0.0"',
  );
  noCalls(sleep, readRuntime, inspect, verifyUpdatedGateway);
  expect(failure.result.verification).toEqual({});
  expect(failure.result.steps).toContainEqual(
    containing({
      name: "gateway recovery observation",
      diagnostics: [expect.stringContaining("no Gateway service or listener")],
    }),
  );
});

it.each([
  { activated: false, json: true, deferred: false },
  { activated: true, json: false, deferred: false },
  { activated: true, json: true, deferred: false },
  { activated: true, json: false, deferred: true },
  { activated: true, json: true, deferred: true },
])(
  "defers only recorded state contention (activated=$activated, json=$json, deferred=$deferred)",
  async ({ activated, json, deferred }) => {
    const env = { ...process.env };
    const run = { runId: updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const readRuntime = vi.fn(async () => ({ status: "unknown" }));
    mockService(readRuntime);
    const inspect = mockFreePort();
    let elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const sleep = vi.spyOn(utils, "sleep").mockImplementation(async (ms) => {
      elapsedMs += ms;
    });
    const waitForStartup = vi.spyOn(restartHealth, "waitForGatewayHealthyRestart");
    mocks.activePort.mockResolvedValueOnce(19431);
    await useRealVerification();
    const failure = await withUpdateCommandTerminalResult(async (registerRun) => {
      registerRun(run);
      await finishSuccessfulPackageSwitch(
        { packageRoot: root, run, json },
        {
          mutationStarted: activated,
          shouldRestart: !activated,
          opts: { json, restart: !activated, run },
          preManagedServiceStop: {
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running: false,
            serviceEnv: env,
          },
          result: {
            status: "error",
            mode: "npm",
            root,
            reason: "doctor-failed",
            recovery: { serviceRestartSafe: true, version: "2026.9.5" },
            steps: [
              ...(deferred
                ? [
                    {
                      name: "post-install-verify",
                      command: "verify installed package",
                      cwd: root,
                      durationMs: 0,
                      exitCode: null,
                      advisory: {
                        kind: "recoverable-maintenance" as const,
                        message: "State verification deferred to the operator restart.",
                      },
                    },
                  ]
                : []),
              {
                name: "candidate-doctor-lint",
                command: "doctor",
                cwd: root,
                exitCode: 2,
                durationMs: 1,
              },
            ],
            durationMs: 1,
          },
        },
      );
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "UpdateCommandFailure",
      exitCode: 1,
      result: { status: "error", reason: "doctor-failed" },
    });
    if (!(failure instanceof ReportedUpdateCommandFailure)) {
      throw failure;
    }
    expect(readRuntime).toHaveBeenCalledTimes(deferred ? 0 : 1);
    expect(inspect).toHaveBeenCalledTimes(deferred ? 0 : 1);
    noCalls(sleep, waitForStartup);
    expect(elapsedMs).toBe(0);
    const recorded = updateLedger.getUpdateRun(run.runId, { env });
    expect(recorded).toMatchObject({
      status: "failed",
      phase: "finished",
      reason: "doctor-failed",
    });
    if (activated) {
      expect(recorded?.steps).toContainEqual(
        containing({
          step: "restart",
          status: "skipped",
          detail: "skipped by operator",
        }),
      );
    }
    expect(recorded?.verification.serviceRunning).toBeUndefined();
    expect(recorded?.verification.readyz).toBe(deferred ? undefined : false);
    expect(recorded?.steps).toContainEqual(
      containing({ step: "candidate-doctor-lint", exitCode: 2 }),
    );
    const recoveryStep = recorded?.steps.find(
      (step) => step.step === "gateway recovery verification",
    );
    expect(recoveryStep).toMatchObject({
      status: deferred ? "completed" : "failed",
      exitCode: deferred ? null : 1,
    });
    if (deferred) {
      expect(recoveryStep?.detail).toContain("deferred");
      expect(recoveryStep?.detail).toContain("service owner");
      expect(recoveryStep?.detail).toContain(
        "Resolve the recorded update failure before restarting",
      );
      expect(recoveryStep?.failureFacts).toBeUndefined();
      assert(recorded);
      expect(renderUpdateRunReport(recorded).markdown).toContain("openclaw update status");
    }
    expect(
      failure.result.steps.find((step) => step.name === "gateway recovery verification")
        ?.termination,
    ).toBeUndefined();
    expect(recoveryStep?.failureFacts?.some((fact) => fact.code === "timeout") ?? false).toBe(
      false,
    );
    expect(mocks.converge).not.toHaveBeenCalled();
    expect(mocks.printResult).toHaveBeenCalledOnce();
  },
);

it.each(["observation", "terminal", "standalone"] as const)(
  "keeps pending recovery facts coherent at %s publication after a transient write failure",
  async (publication) => {
    const { verifyUpdateFailureRecovery } = await import("./update-command-failure-recovery.js");
    const env = { ...process.env };
    const lifecycle = new UpdateFinalizationLifecycle(true, undefined, () => {});
    lifecycle.root = root;
    const run = {
      runId:
        publication === "standalone"
          ? lifecycle.attachLedger()
          : updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId,
    };
    updateLedger.recordUpdateRunVerification(
      run.runId,
      {
        serviceRunning: true,
        versionMatch: true,
        readyz: true,
        settled: true,
        runningVersion: "2026.9.5",
        channelsReady: true,
        pluginErrors: [],
        recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
      },
      { env },
    );
    updateLedger.recordUpdateRunStep(
      run.runId,
      {
        step: "gateway recovery verification",
        status: "completed",
        exitCode: 0,
      },
      { env },
    );
    const capture = vi.spyOn(updateLedger, "recordUpdateRunDiagnostics");
    if (publication !== "observation") {
      capture.mockImplementationOnce((_id, _facts, warn) => {
        warn("fixture observation write refused");
      });
    }
    mocks.activePort.mockResolvedValueOnce(19431);
    vi.mocked(verifyUpdatedGateway).mockImplementationOnce(async (params) => {
      const actual = await vi.importActual<typeof import("./update-command-verification.js")>(
        "./update-command-verification.js",
      );
      return actual.verifyUpdatedGateway({
        ...params,
        health: {
          healthy: false,
          waitOutcome: "still-starting",
          runtime: { status: "running", pid: 8000 },
          portUsage: { port: 19431, status: "free", listeners: [], hints: [] },
          staleGatewayPids: [],
        },
      });
    });
    const failureResult = {
      status: "error" as const,
      mode: "npm" as const,
      reason: "post-update-plugins",
      steps: [],
      durationMs: 0,
    };
    if (publication === "standalone") {
      await lifecycle.observeFailure(new ReportedUpdateCommandFailure(failureResult));
      lifecycle.complete(1);
    } else {
      const observed = await verifyUpdateFailureRecovery({
        result: failureResult,
        root,
        env,
        opts: { json: true, run: { runId: run.runId, env } },
      });
      if (publication === "terminal") {
        completeUpdateCommandRun(observed, { runId: run.runId, env });
      }
    }
    expect(capture).toHaveBeenCalled();
    const recorded = updateLedger.getUpdateRun(run.runId, { env });
    expect(recorded).toMatchObject({
      confirmedAtMs: null,
      verification: { readyz: false },
      status: publication === "observation" ? "running" : "failed",
    });
    expect(recorded?.verification.runningVersion).toBeUndefined();
    expect(
      recorded?.steps.findLast((step) => step.step === "gateway recovery verification")?.exitCode,
    ).toBeNull();
    if (!recorded) {
      throw new Error("Missing recovery observation record");
    }
    expect(renderUpdateRunReport(recorded).markdown).not.toContain("verified serving");
  },
);

it("does not reconfirm the same Gateway version against a different installed build", async () => {
  const runningVersion = "2026.9.5";
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "dist", "build-info.json"),
    JSON.stringify({ buildId: "installed-build" }),
  );
  const lifecycle = new UpdateFinalizationLifecycle(true, undefined, () => {});
  lifecycle.root = root;
  const runId = lifecycle.attachLedger();
  updateLedger.recordUpdateRunVerification(runId, {
    recovery: {
      serviceRestartSafe: true,
      service: "healthy",
      version: runningVersion,
      buildId: "previous-build",
    },
  });
  mocks.activePort.mockResolvedValueOnce(19431);
  vi.mocked(verifyUpdatedGateway).mockImplementationOnce(
    async ({ expectedVersion, expectedBuildId }) => {
      const ok = expectedVersion === runningVersion && expectedBuildId === "previous-build";
      return {
        ok,
        score: ok ? 7 : 0,
        summary: ok ? "healthy" : "installed runtime identity mismatch",
      };
    },
  );
  const observed = await lifecycle.observeFailure(new Error("plugin finalization failed"));
  lifecycle.complete(1);
  expect(observed?.recovery).toMatchObject({
    service: "failed",
    reason: "installed runtime identity mismatch",
  });
  expect(updateLedger.getUpdateRun(runId)?.verification.recovery).toMatchObject({
    service: "failed",
  });
  expect(verifyUpdatedGateway).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expectedVersion: "2026.9.5",
      expectedBuildId: "installed-build",
    }),
  );
});

it.each(["ownership", "native status"] as const)(
  "does not publish recovery while %s inspection cleanup is uncertain",
  async (kind) => {
    const cleanup = new CommandProcessCleanupError();
    const env = { ...process.env };
    const run = { runId: updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    if (kind === "native status") {
      mocks.activePort.mockResolvedValueOnce(19431);
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
        ...gatewayService.resolveGatewayService(),
        readRuntime: async () => {
          throw cleanup;
        },
      });
    } else {
      mocks.managedService.mockRejectedValueOnce(cleanup);
    }
    failedPlugins();
    await expect(
      withUpdateCommandTerminalResult(async (registerRun) => {
        registerRun(run);
        await finishSuccessfulPackageSwitch({
          packageRoot: root,
          json: true,
          run,
          ...(kind === "native status" ? { restartEnvironment: env, stoppedForUpdate: true } : {}),
        });
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandProcessCleanupError);
      expect(collectNestedErrorCandidates(error)).toContain(cleanup);
      return true;
    });
    expect(updateLedger.getUpdateRun(run.runId, { env })?.status).toBe("running");
    noCalls(mocks.printResult, verifyUpdatedGateway);
  },
);

it.each([
  { endpoint: "foreground", failure: "returned", unsafe: false },
  { endpoint: "managed", failure: "returned", unsafe: false },
  { endpoint: "configured", failure: "returned", unsafe: false },
  { endpoint: "configured", failure: "thrown", unsafe: false },
  { endpoint: "configured", failure: "returned", unsafe: true },
] as const)(
  "observes $endpoint recovery after $failure failure (unsafe=$unsafe)",
  async ({ endpoint, failure, unsafe }) => {
    const effectivePort = endpoint !== "configured";
    if (effectivePort) {
      vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19430");
    }
    if (endpoint === "foreground") {
      mocks.activePort.mockResolvedValueOnce(19431);
    } else if (endpoint === "managed") {
      mocks.managedService.mockResolvedValueOnce({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: {},
        command: {
          programArguments: ["node", path.join(root, "openclaw.mjs"), "gateway", "--port", "19431"],
        },
        verdict: { kind: "owned", root, fingerprint: "fixture", refreshDefinition: false },
      });
    }
    vi.mocked(verifyUpdatedGateway).mockImplementationOnce(async ({ gatewayPort }) => {
      const ok = !effectivePort || gatewayPort === 19431;
      return {
        ok,
        score: ok ? 7 : 0,
        summary: ok ? "Gateway version and readiness verified." : "wrong Gateway endpoint",
      };
    });
    const unsafeReason = "state-migration-started";
    if (failure === "thrown") {
      mocks.converge.mockRejectedValueOnce(new Error("plugin finalization failed"));
    } else {
      failedPlugins(unsafe ? { serviceRestartSafe: false, reason: unsafeReason } : undefined);
    }
    const recovery = unsafe
      ? { serviceRestartSafe: false, reason: unsafeReason }
      : { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" };
    await expect(
      finishSuccessfulPackageSwitch({ packageRoot: root, json: true }),
    ).rejects.toMatchObject({
      result: {
        status: "error",
        reason: failure === "thrown" ? "post-update-failed" : "post-update-plugins",
        recovery,
      },
    });
    expect(verifyUpdatedGateway).toHaveBeenCalledOnce();
    if (effectivePort) {
      expect(verifyUpdatedGateway).toHaveBeenCalledWith(
        containing({ gatewayPort: 19431, expectedVersion: "2026.9.5" }),
      );
    } else if (!unsafe) {
      expect(verifyUpdatedGateway).toHaveBeenCalledWith(
        containing({ purpose: "recovery", expectedVersion: "2026.9.5" }),
      );
      expect(mocks.printResult).toHaveBeenCalledWith(
        containing({ recovery }),
        expect.anything(),
        expect.anything(),
      );
    }
  },
);
