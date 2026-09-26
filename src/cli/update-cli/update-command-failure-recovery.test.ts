import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gatewayService from "../../daemon/service.js";
import * as ports from "../../infra/ports-inspect.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import * as utils from "../../utils.js";
import { finishSuccessfulPackageSwitch } from "./update-command-post-update.test-support.js";
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.activePort.mockReset();
  mocks.managedService.mockReset();
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("failure-recovery-state-"));
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("post-update failure recovery observation", () => {
  it("reports a preactivation Doctor failure after one observation of an unknown foreground setup", async () => {
    const root = dirs.make("preactivation-recovery-");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.5" }));
    const env = { ...process.env };
    const run = { runId: updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const readRuntime = vi.fn(async () => ({ status: "unknown" }));
    vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
      ...gatewayService.resolveGatewayService(),
      readRuntime,
      readCommand: vi.fn(async () => null),
      isLoaded: vi.fn(async () => false),
    });
    const inspect = vi.spyOn(ports, "inspectPortUsage").mockImplementation(async (port) => ({
      port,
      status: "free",
      listeners: [],
      hints: [],
    }));
    let elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const sleep = vi.spyOn(utils, "sleep").mockImplementation(async (ms) => {
      elapsedMs += ms;
    });
    mocks.activePort.mockResolvedValueOnce(19431);
    const actual = await vi.importActual<typeof import("./update-command-verification.js")>(
      "./update-command-verification.js",
    );
    vi.mocked(verifyUpdatedGateway).mockImplementationOnce(actual.verifyUpdatedGateway);
    const failure = await withUpdateCommandTerminalResult(async (registerRun) => {
      registerRun(run);
      await finishSuccessfulPackageSwitch(
        { packageRoot: root, run, json: true },
        {
          mutationStarted: false,
          shouldRestart: true,
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
    expect(readRuntime).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledExactlyOnceWith(19431, expect.anything());
    expect(sleep).not.toHaveBeenCalled();
    expect(elapsedMs).toBe(0);
    const recorded = updateLedger.getUpdateRun(run.runId, { env });
    expect(recorded).toMatchObject({ status: "failed", reason: "doctor-failed" });
    expect(recorded?.verification.serviceRunning).toBeUndefined();
    expect(recorded?.verification.readyz).toBe(false);
    expect(recorded?.steps).toContainEqual(
      expect.objectContaining({ step: "candidate-doctor-lint", exitCode: 2 }),
    );
    const recoveryStep = recorded?.steps.find(
      (step) => step.step === "gateway recovery verification",
    );
    expect(recoveryStep).toMatchObject({ status: "failed", exitCode: 1 });
    expect(
      failure.result.steps.find((step) => step.name === "gateway recovery verification")
        ?.termination,
    ).toBeUndefined();
    expect(recoveryStep?.failureFacts?.some((fact) => fact.code === "timeout")).toBe(false);
    expect(mocks.converge).not.toHaveBeenCalled();
    expect(mocks.printResult).toHaveBeenCalledOnce();
  });

  it.each(["observation", "terminal", "standalone"] as const)(
    "keeps pending recovery facts coherent at %s publication after a transient write failure",
    async (publication) => {
      const { verifyUpdateFailureRecovery } = await import("./update-command-failure-recovery.js");
      const root = dirs.make("recovery-observation-receipt-");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
      );
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
        const { UpdateCommandFailure } = await import("./update-command-result.js");
        await lifecycle.observeFailure(new UpdateCommandFailure(failureResult));
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
      expect(recorded?.verification.readyz).toBe(false);
      expect(
        recorded?.steps.findLast((step) => step.step === "gateway recovery verification")?.exitCode,
      ).toBeNull();
      expect(recorded?.confirmedAtMs).toBeNull();
      expect(recorded?.verification.runningVersion).toBeUndefined();
      expect(recorded?.status).toBe(publication === "observation" ? "running" : "failed");
      if (!recorded) {
        throw new Error("Missing recovery observation record");
      }
      expect(renderUpdateRunReport(recorded).markdown).not.toContain("verified serving");
    },
  );

  it.each(["2026.9.4", "2026.9.5"])(
    "does not reconfirm a stale recovered Gateway %s against a different installed build",
    async (runningVersion) => {
      const root = dirs.make("recovery-installed-identity-");
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.5" }));
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
    },
  );

  it.each(["ownership", "native status"] as const)(
    "does not publish recovery while %s inspection cleanup is uncertain",
    async (kind) => {
      const root = dirs.make("unsettled-recovery-inspection-");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
      );
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
      mocks.converge.mockImplementationOnce(async ({ result }) => ({
        resultWithPostUpdate: { ...result, status: "error", reason: "post-update-plugins" },
      }));
      await expect(
        withUpdateCommandTerminalResult(async (registerRun) => {
          registerRun(run);
          await finishSuccessfulPackageSwitch({
            packageRoot: root,
            json: true,
            run,
            ...(kind === "native status"
              ? { restartEnvironment: env, stoppedForUpdate: true }
              : {}),
          });
        }),
      ).rejects.toBe(cleanup);
      expect(updateLedger.getUpdateRun(run.runId, { env })?.status).toBe("running");
      expect(mocks.printResult).not.toHaveBeenCalled();
      expect(verifyUpdatedGateway).not.toHaveBeenCalled();
    },
  );

  it.each(["foreground", "managed"] as const)(
    "probes the %s Gateway's effective port instead of a different configured endpoint",
    async (kind) => {
      const root = dirs.make("effective-recovery-endpoint-");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
      );
      vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19430");
      if (kind === "foreground") {
        mocks.activePort.mockResolvedValueOnce(19431);
      } else {
        mocks.managedService.mockResolvedValueOnce({
          installed: true,
          loadState: { status: "loaded" },
          running: true,
          env: {},
          command: {
            programArguments: [
              "node",
              path.join(root, "openclaw.mjs"),
              "gateway",
              "--port",
              "19431",
            ],
          },
          verdict: { kind: "owned", root, fingerprint: "fixture", refreshDefinition: false },
        });
      }
      vi.mocked(verifyUpdatedGateway).mockImplementationOnce(async ({ gatewayPort }) => ({
        ok: gatewayPort === 19431,
        score: gatewayPort === 19431 ? 7 : 0,
        summary: gatewayPort === 19431 ? "healthy" : "wrong Gateway endpoint",
      }));
      mocks.converge.mockImplementationOnce(async ({ result }) => ({
        resultWithPostUpdate: { ...result, status: "error", reason: "post-update-plugins" },
      }));
      await expect(
        finishSuccessfulPackageSwitch({ packageRoot: root, json: true }),
      ).rejects.toMatchObject({
        result: { recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" } },
      });
      expect(verifyUpdatedGateway).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayPort: 19431, expectedVersion: "2026.9.5" }),
      );
    },
  );

  it.each(["state-migration-started", "runtime-verification-failed"] as const)(
    "preserves an explicit %s verdict even when the Gateway is healthy",
    async (reason) => {
      const root = dirs.make("unsafe-serving-recovery-");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
      );
      vi.mocked(verifyUpdatedGateway).mockResolvedValueOnce({
        ok: true,
        score: 7,
        summary: "Gateway version and readiness verified.",
      });
      mocks.converge.mockImplementationOnce(async ({ result }) => ({
        resultWithPostUpdate: {
          ...result,
          status: "error",
          reason: "post-update-plugins",
          recovery: { serviceRestartSafe: false, reason },
        },
      }));
      await expect(
        finishSuccessfulPackageSwitch({ packageRoot: root, json: true }),
      ).rejects.toMatchObject({
        result: { recovery: { serviceRestartSafe: false, reason } },
      });
      expect(verifyUpdatedGateway).toHaveBeenCalledOnce();
    },
  );

  it.each(["returned", "thrown"] as const)(
    "records a serving Gateway after a %s post-update failure",
    async (failure) => {
      const root = dirs.make("post-update-serving-recovery-");
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
      );
      vi.mocked(verifyUpdatedGateway).mockResolvedValueOnce({
        ok: true,
        score: 7,
        summary: "Gateway version and readiness verified.",
      });
      if (failure === "thrown") {
        mocks.converge.mockRejectedValueOnce(new Error("plugin finalization failed"));
      } else {
        mocks.converge.mockImplementationOnce(async ({ result }) => ({
          resultWithPostUpdate: { ...result, status: "error", reason: "post-update-plugins" },
        }));
      }
      await expect(
        finishSuccessfulPackageSwitch({ packageRoot: root, json: true }),
      ).rejects.toMatchObject({
        result: {
          status: "error",
          reason: failure === "thrown" ? "post-update-failed" : "post-update-plugins",
          recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
        },
      });
      expect(verifyUpdatedGateway).toHaveBeenCalledOnce();
      expect(verifyUpdatedGateway).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: "recovery", expectedVersion: "2026.9.5" }),
      );
      expect(mocks.printResult).toHaveBeenCalledWith(
        expect.objectContaining({
          recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
        }),
        expect.anything(),
        expect.anything(),
      );
    },
  );
});
