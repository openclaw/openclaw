import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gatewayService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  createUpdateConfigSnapshot: vi.fn(async () => undefined),
  runRestartScript: vi.fn(async () => true),
  runUpdatedInstallGatewayCommand: vi.fn<
    typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
  >(async (_params, action) => (action === "restart" ? "accepted" : "unverified")),
  waitForGatewayHealthyRestart: vi.fn(),
  waitForGatewayHttpReadiness: vi.fn(),
  inspectGatewayRestart: vi.fn(),
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.runUpdatedInstallGatewayCommand,
}));
vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  recordUpdateRunPhase: vi.fn(),
  recordUpdateRunStep: vi.fn(),
  recordUpdateRunVerification: vi.fn(),
}));
vi.mock("../daemon-cli/restart-health-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health-probe.js")>()),
  resolveGatewayRestartProbeContext: async () => ({ config: {}, auth: undefined }),
}));

vi.mock("../../infra/gateway-supervision.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-supervision.js")>()),
  assertGatewayServiceMutationAllowed: vi.fn(),
}));

vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: mocks.waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness: mocks.waitForGatewayHttpReadiness,
  inspectGatewayRestart: mocks.inspectGatewayRestart,
}));

vi.mock("./restart-helper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart-helper.js")>()),
  runRestartScript: mocks.runRestartScript,
}));

vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: mocks.createUpdateConfigSnapshot,
}));

import { prepareUpdateServiceResult } from "./update-command-result.js";
import { maybeRestartService } from "./update-command-service.js";

const gateway = { bootId: "test-boot", version: "2026.9.1", buildId: "new-build" };
const run = { runId: "00000000-0000-4000-8000-000000000001", env: {} };
describe("maybeRestartService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitForGatewayHttpReadiness.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
    const healthy = {
      runtime: { status: "running", pid: 8000 },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
      healthy: true,
      staleGatewayPids: [],
      gatewayBuildId: gateway.buildId,
      gatewayVersion: gateway.version,
      gatewayBootId: gateway.bootId,
    };
    mocks.waitForGatewayHealthyRestart.mockResolvedValue(healthy);
    mocks.inspectGatewayRestart.mockResolvedValue(healthy);
  });

  it.each([
    "current",
    "revoked",
    "aborted",
    "initial-stopped",
    "initial-stopped-reachable",
    "initial-plugin-error",
    "initial-plugin-unavailable",
    "initial-channel-error",
    "initial-readyz-error",
    "initial-readyz-rollback",
    "initial-version-error",
    "initial-build-error",
    "initial-settle-error",
  ] as const)(
    "accepts readiness only for the original live executor and healthy service: %s",
    async (change) => {
      const home = tempDirs.make("readiness-live-executor-");
      const options = { env: { HOME: home, OPENCLAW_STATE_DIR: home } };
      const admitted = createUpdateRun({ trigger: "cli" }, options);
      let current = true;
      const fence = {
        assertCurrent() {
          if (!current) {
            throw new Error("owner revoked");
          }
        },
      };
      const rollback = change === "initial-readyz-rollback";
      const pluginOnly =
        change === "initial-plugin-error" || change === "initial-plugin-unavailable";
      const initialFailure = change.startsWith("initial-") && !pluginOnly;
      const healthy = await mocks.inspectGatewayRestart();
      if (change.startsWith("initial-")) {
        const health = await mocks.waitForGatewayHealthyRestart();
        const observedHealth = {
          ...health,
          healthy:
            pluginOnly ||
            change === "initial-readyz-error" ||
            rollback ||
            change === "initial-stopped-reachable",
          runtime: {
            status: change.startsWith("initial-stopped") ? "stopped" : "running",
            pid: 8000,
          },
          ...(change === "initial-version-error"
            ? {
                versionMismatch: { expected: "2026.9.2", actual: gateway.version },
                expectedVersion: "2026.9.2",
              }
            : {}),
          ...(change === "initial-build-error"
            ? {
                buildIdMismatch: { expected: "expected-build", actual: gateway.buildId },
                expectedBuildId: "expected-build",
              }
            : {}),
          ...(change === "initial-settle-error"
            ? { waitOutcome: "timeout", probeError: "Gateway did not settle" }
            : {}),
          ...(change === "initial-plugin-error" || change.startsWith("initial-stopped")
            ? {
                activatedPluginErrors: [
                  { id: "fixture", origin: "global", activated: true, error: "failed" },
                ],
              }
            : {}),
          ...(change === "initial-plugin-unavailable"
            ? {
                unavailablePlugins: [
                  { id: "fixture", reason: "missing-extension-entry", detail: "Entry missing" },
                ],
              }
            : {}),
          ...(change === "initial-channel-error"
            ? { channelProbeErrors: [{ id: "fixture-channel", error: "connection failed" }] }
            : {}),
        };
        mocks.waitForGatewayHealthyRestart.mockResolvedValue(observedHealth);
        mocks.inspectGatewayRestart.mockResolvedValue(observedHealth);
      }
      const controller = new AbortController();
      mocks.waitForGatewayHttpReadiness.mockImplementationOnce(async () => {
        if (change === "aborted") {
          controller.abort();
        }
        current = change !== "revoked";
        return { healthz: 200, readyz: change === "initial-readyz-error" || rollback ? 503 : 200 };
      });
      const onVerified = vi.fn();
      const opts = {
        json: true,
        run: { runId: admitted.runId, env: options.env, executorFence: fence },
      };
      const updateResult: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
      const verification = verifyUpdatedGateway({
        opts,
        signal: controller.signal,
        requireRunningService: true,
        result: updateResult,
        serviceEnv: {
          ...options.env,
          ...(pluginOnly ? { OPENCLAW_PROFILE: "service-profile" } : {}),
          ...(change === "initial-plugin-unavailable"
            ? { OPENCLAW_CONTAINER_HINT: "service-box" }
            : {}),
        },
        gatewayPort: 18789,
        expectedVersion: gateway.version,
        expectedBuildId: gateway.buildId,
        onVerified,
      });
      if (initialFailure) {
        await expect(verification).resolves.toMatchObject({ ok: false });
        expect(onVerified).not.toHaveBeenCalled();
        const failingCheck =
          change === "initial-version-error"
            ? { check: "versionMatch", code: "version-mismatch" }
            : change === "initial-build-error"
              ? { check: "versionMatch", code: "build-id-mismatch" }
              : change === "initial-channel-error"
                ? {
                    check: "channelsReady",
                    code: "channel-errors",
                    pluginId: "fixture-channel",
                    message: "connection failed",
                  }
                : change === "initial-readyz-error" || rollback
                  ? { check: "readyz", code: "readyz-unhealthy" }
                  : change === "initial-settle-error"
                    ? { check: "settled", code: "timeout" }
                    : { check: "service", code: "service-not-running" };
        expect(updateResult.steps).toContainEqual(
          expect.objectContaining({
            name: "gateway verification",
            exitCode: 1,
            failureFacts: expect.arrayContaining([expect.objectContaining(failingCheck)]),
          }),
        );
        expect(recordUpdateRunStep).toHaveBeenCalledWith(
          admitted.runId,
          expect.objectContaining({
            step: "gateway verification",
            status: "failed",
            failureFacts: expect.arrayContaining([expect.objectContaining(failingCheck)]),
          }),
          expect.anything(),
        );
        if (rollback) {
          updateResult.recovery = {
            serviceRestartSafe: true,
            packageRollbackVerified: true,
            version: gateway.version,
          };
        }
        mocks.inspectGatewayRestart.mockResolvedValue(healthy);
        await expect(
          verifyUpdatedGateway({
            opts,
            result: updateResult,
            health: healthy,
            serviceEnv: options.env,
            gatewayPort: 18789,
            requireRunningService: true,
          }),
        ).resolves.toMatchObject({ ok: true });
        if (rollback) {
          expect(updateResult.steps).toEqual([
            expect.objectContaining({
              name: "gateway verification",
              exitCode: 1,
              failureFacts: expect.arrayContaining([
                expect.objectContaining({ code: "readyz-unhealthy" }),
              ]),
            }),
            expect.objectContaining({ name: "rollback gateway verification", exitCode: 0 }),
          ]);
        } else {
          expect(updateResult.steps).toEqual([
            expect.objectContaining({ name: "gateway verification", exitCode: 0 }),
          ]);
          expect(updateResult.steps[0]?.failureFacts).toBeUndefined();
        }
        expect(updateResult.steps.at(-1)?.advisory).toBeUndefined();
        expect(updateResult.steps.at(-1)?.termination).toBeUndefined();
        expect(recordUpdateRunStep).toHaveBeenLastCalledWith(
          admitted.runId,
          expect.objectContaining({
            step: rollback ? "rollback gateway verification" : "gateway verification",
            status: "completed",
            failureFacts: undefined,
          }),
          expect.anything(),
        );
      } else if (change === "aborted" || change === "revoked") {
        await expect(verification).rejects.toMatchObject({
          name: change === "aborted" ? "AbortError" : "Error",
        });
        expect(onVerified).not.toHaveBeenCalled();
        expect(recordUpdateRunStep).not.toHaveBeenCalledWith(
          admitted.runId,
          expect.objectContaining({ step: "gateway verification", status: "completed" }),
          expect.anything(),
        );
      } else {
        const result = await verification;
        expect(result.ok).toBe(true);
        if (pluginOnly) {
          const retry =
            change === "initial-plugin-unavailable"
              ? "openclaw --container service-box doctor --fix"
              : "openclaw --profile service-profile doctor --fix";
          expect(result.pluginWarnings).toEqual([
            expect.objectContaining({
              pluginId: "fixture",
              message: expect.stringContaining("could not be loaded"),
              guidance: [retry],
            }),
          ]);
          expect(result.summary).toContain("plugin failures need a retry");
          expect(mocks.waitForGatewayHealthyRestart).toHaveBeenCalledWith(
            expect.objectContaining({ requirePluginHealth: false }),
          );
        }
        expect(onVerified).toHaveBeenCalledOnce();
      }
      expect(loadUpdateRecovery(admitted.runId, options)).toBeUndefined();
    },
  );

  it("refuses a supplied legacy readiness context before any probe or acknowledgement", async () => {
    const home = tempDirs.make("readiness-retained-refusal-");
    const options = { env: { HOME: home, OPENCLAW_STATE_DIR: home } };
    const admitted = createUpdateRun({ trigger: "cli" }, options);
    const runtime = {
      root: home,
      nodePath: process.execPath,
      version: gateway.version,
      buildId: gateway.buildId,
    };
    const record = createRetainedUpdateRecovery(
      { runId: admitted.runId, from: runtime, to: runtime },
      options,
    );
    const onVerified = vi.fn();
    await expect(
      verifyUpdatedGateway({
        opts: {
          json: true,
          run: { runId: admitted.runId, env: options.env },
          recovery: { getRecord: () => record },
        },
        result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
        serviceEnv: options.env,
        gatewayPort: 18789,
        onVerified,
      }),
    ).rejects.toMatchObject({ name: "UpdateCommandRecoveryPendingError" });
    expect(mocks.waitForGatewayHealthyRestart).not.toHaveBeenCalled();
    expect(mocks.waitForGatewayHttpReadiness).not.toHaveBeenCalled();
    expect(onVerified).not.toHaveBeenCalled();
    expect(loadUpdateRecovery(record.runId, options)).toEqual(record);
  });

  it.each(["seal refused", "target install failed", "missing entrypoint"])(
    "never falls back to restart after gated install failure: %s",
    async (reason) => {
      const serviceLoadBoundary = { assertCurrent: vi.fn(), seal: vi.fn() };
      if (reason === "missing entrypoint") {
        const actual = await vi.importActual<typeof import("./update-command-service-command.js")>(
          "./update-command-service-command.js",
        );
        mocks.runUpdatedInstallGatewayCommand.mockImplementationOnce(
          actual.runUpdatedInstallGatewayCommand,
        );
      } else {
        mocks.runUpdatedInstallGatewayCommand.mockRejectedValueOnce(new Error(reason));
      }
      const onVerified = vi.fn();
      await expect(
        maybeRestartService({
          shouldRestart: true,
          result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
          opts: { json: true, run },
          refreshServiceEnv: true,
          serviceEnv: { HOME: "/home/operator" },
          serviceInstallEnv: {},
          serviceLoadBoundary,
          gatewayPort: 18789,
          restartScriptPath: "/tmp/openclaw-sealed-restart.sh",
          timeoutMs: 1_000,
          onVerified,
        }),
      ).rejects.toMatchObject({ name: "UpdateServiceLoadBoundaryError" });
      expect(mocks.runUpdatedInstallGatewayCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ serviceLoadBoundary }),
        "install",
      );
      expect(mocks.runRestartScript).not.toHaveBeenCalled();
      expect(mocks.waitForGatewayHealthyRestart).not.toHaveBeenCalled();
      expect(onVerified).not.toHaveBeenCalled();
    },
  );

  it("records changed-key warnings before health verification and retains them in the outcome and report", async () => {
    const home = tempDirs.make("service-warning-history-");
    const options = { env: { HOME: home, OPENCLAW_STATE_DIR: home } };
    const admitted = createUpdateRun({ trigger: "cli" }, options);
    const liveRun = { ...run, runId: admitted.runId, env: options.env };
    const ledger = await vi.importActual<typeof import("../../infra/update-run-ledger.js")>(
      "../../infra/update-run-ledger.js",
    );
    const warning = "Reconciled Gateway service definition: Service.KillMode. Backup retained.";
    mocks.runUpdatedInstallGatewayCommand.mockImplementationOnce(async (params) => {
      params.onWarnings?.([warning]);
      return "unverified";
    });
    const healthy = await mocks.waitForGatewayHealthyRestart();
    let observedDuringHealth: ReturnType<typeof getUpdateRun>;
    mocks.waitForGatewayHealthyRestart.mockImplementationOnce(async () => {
      observedDuringHealth = getUpdateRun(admitted.runId, options);
      return healthy;
    });
    const result: UpdateRunResult = {
      status: "ok",
      mode: "npm",
      after: { version: gateway.version, buildId: gateway.buildId },
      steps: [],
      durationMs: 0,
    };
    await vi
      .mocked(recordUpdateRunStep)
      .withImplementation(ledger.recordUpdateRunStep, async () => {
        await expect(
          maybeRestartService({
            shouldRestart: true,
            result,
            opts: { json: true, run: liveRun },
            refreshServiceEnv: true,
            serviceEnv: { HOME: "/home/operator" },
            serviceInstallEnv: {},
            gatewayPort: 18789,
            timeoutMs: 1_000,
          }),
        ).resolves.toBe("ok");
      });
    expect(observedDuringHealth?.steps).toContainEqual(
      expect.objectContaining({
        step: "warning:managed-service-reconciliation",
        status: "completed",
        detail: warning,
      }),
    );
    expect(result.steps).toContainEqual(expect.objectContaining({ warnings: [warning] }));
    expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
      warning,
    );
  });

  it.for(
    ["installed", "registration rejected", "activation uncertain", "definition unchanged"].flatMap(
      (outcome) => ["default", "work"].map((profile) => ({ outcome, profile })),
    ),
  )(
    "keeps a Windows two-prefix reconciliation available ($outcome, $profile)",
    async ({ outcome, profile }, { onTestFinished }) => {
      vi.stubEnv("OPENCLAW_PROFILE", "caller");
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const platform = mockProcessPlatform("win32");
      onTestFinished(() => platform.mockRestore());
      const home = await fs.realpath(tempDirs.make("update-task-prefixes-"));
      const roots = [path.join(home, "prefix-a"), path.join(home, "prefix-b")] as const;
      for (const root of roots) {
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version: gateway.version }),
        );
        await fs.writeFile(path.join(root, "dist/index.js"), "export {};\n");
      }
      let commandRoot = roots[0];
      let servingRoot = roots[0];
      const service = vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
        createMockGatewayService({
          isLoaded: async () => true,
          readRuntime: async () => ({ status: "running", pid: 8000 }),
          readCommand: async () => ({
            programArguments: [
              process.execPath,
              path.join(commandRoot, "dist/index.js"),
              "gateway",
            ],
          }),
        }),
      );
      onTestFinished(() => service.mockRestore());
      mocks.runUpdatedInstallGatewayCommand.mockImplementation(async (_params, action) => {
        if (action === "install") {
          if (outcome === "registration rejected" || outcome === "activation uncertain") {
            throw new Error(outcome);
          }
          if (outcome === "installed") {
            commandRoot = roots[1];
          }
          return "unverified";
        }
        servingRoot = commandRoot;
        return "accepted";
      });
      onTestFinished(() => {
        mocks.runUpdatedInstallGatewayCommand
          .mockReset()
          .mockImplementation(async (_params, action) =>
            action === "restart" ? "accepted" : "unverified",
          );
      });
      const result: UpdateRunResult = {
        status: "ok",
        mode: "npm",
        root: roots[1],
        before: { version: gateway.version },
        after: { version: gateway.version },
        steps: [],
        durationMs: 0,
      };
      const actual = await maybeRestartService({
        shouldRestart: true,
        result,
        opts: { json: true },
        refreshServiceEnv: true,
        serviceEnv: { HOME: home, OPENCLAW_PROFILE: profile },
        requireRunningServiceAfterRestart: true,
        serviceUpdateVerdict: {
          kind: "owned",
          root: roots[0],
          fingerprint: "original",
          refreshDefinition: true,
          requiresInstallRootRefresh: true,
        },
        gatewayPort: 18789,
        timeoutMs: 1_000,
      });
      expect(actual).toBe(outcome === "installed" ? "ok" : "reconciliation-pending");
      expect(servingRoot).toBe(outcome === "installed" ? roots[1] : roots[0]);
      expect(mocks.runUpdatedInstallGatewayCommand.mock.calls.map(([, action]) => action)).toEqual(
        outcome === "installed" ? ["install", "restart"] : ["install"],
      );
      if (outcome !== "installed") {
        if (outcome !== "definition unchanged") {
          expect(result.steps[0]?.advisory?.message).toContain(outcome);
        }
        const cli = profile === "default" ? "openclaw" : "openclaw --profile work";
        expect(result.steps).toEqual([
          expect.objectContaining({
            command: `${cli} gateway install --force`,
            advisory: expect.objectContaining({
              message: expect.stringContaining(
                `Run \`${cli} gateway install --force\`, then \`${cli} gateway restart\`.`,
              ),
            }),
          }),
          expect.objectContaining({
            advisory: expect.objectContaining({
              message: expect.stringContaining(`Inspect \`${cli} gateway status --deep\``),
            }),
          }),
        ]);
      }
    },
  );

  it.each(["default", "work"])(
    "preserves the selected profile in skipped reconciliation: %s",
    (profile) => {
      const result: UpdateRunResult = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
      expect(
        prepareUpdateServiceResult({
          result,
          root: "/cli-install",
          shouldRestart: false,
          preManagedServiceStop: {
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running: false,
            serviceEnv: { OPENCLAW_PROFILE: profile },
            serviceUpdateVerdict: {
              kind: "owned",
              root: "/service-install",
              fingerprint: "original",
              refreshDefinition: true,
              requiresInstallRootRefresh: true,
            },
          },
        }),
      ).toBe(false);
      const cli = profile === "default" ? "openclaw" : "openclaw --profile work";
      expect(result.steps).toEqual([
        expect.objectContaining({
          command: `${cli} gateway install --force`,
          advisory: expect.objectContaining({
            message: expect.stringContaining(`Run \`${cli} doctor --fix\``),
          }),
        }),
      ]);
    },
  );

  it.each(["new-build", undefined])(
    "enforces the available Git identity after restart: %s",
    async (buildId) => {
      const result = {
        status: "ok",
        mode: "git",
        root: "/tmp/openclaw-configured-ui-update",
        after: { version: "2026.9.1", buildId },
        steps: [],
        durationMs: 0,
      } satisfies UpdateRunResult;

      await expect(
        maybeRestartService({
          shouldRestart: true,
          result,
          opts: { json: true, run },
          refreshServiceEnv: false,
          serviceEnv: { HOME: "/home/operator" },
          serviceInstallEnv: {},
          gatewayPort: 18789,
          restartScriptPath: "/tmp/openclaw-configured-ui-restart.sh",
          timeoutMs: 1_000,
        }),
      ).resolves.toBe("ok");

      expect(mocks.runRestartScript).toHaveBeenCalledWith(
        "/tmp/openclaw-configured-ui-restart.sh",
        1_000,
      );
      expect(mocks.waitForGatewayHealthyRestart.mock.lastCall?.[0].expectedBuildId).toBe(buildId);
    },
  );

  it("does not infer activation from a detached script when the expected Git build is never observed", async () => {
    mocks.runRestartScript.mockResolvedValueOnce(false);
    mocks.waitForGatewayHealthyRestart.mockResolvedValue({
      runtime: { status: "stopped" },
      portUsage: {
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      },
      healthy: false,
      staleGatewayPids: [],
      expectedBuildId: "new-build",
      waitOutcome: "timeout",
    });

    await expect(
      maybeRestartService({
        shouldRestart: true,
        result: {
          status: "ok",
          mode: "git",
          root: "/tmp/openclaw-configured-ui-update",
          after: { version: "2026.9.1", buildId: "new-build" },
          steps: [],
          durationMs: 0,
        },
        opts: { json: true, run },
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/home/operator" },
        serviceInstallEnv: {},
        gatewayPort: 18789,
        restartScriptPath: "/tmp/openclaw-configured-ui-restart.sh",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("failed");
  });

  it.each(
    [false, true].flatMap((refreshServiceEnv) => [
      { refreshServiceEnv, readyz: 503, verified: false },
      { refreshServiceEnv, readyz: 200, verified: true },
    ]),
  )(
    "requires HTTP readiness (readyz=$readyz, refresh=$refreshServiceEnv)",
    async ({ refreshServiceEnv, readyz, verified }) => {
      mocks.waitForGatewayHttpReadiness.mockResolvedValue({ healthz: 200, readyz });
      const onVerified = vi.fn();
      const onVerificationFailure = vi.fn();
      const startedAtMs = Date.now();
      const actual = await maybeRestartService({
        shouldRestart: true,
        result: {
          status: "ok",
          mode: "git",
          after: { version: "2026.9.1", buildId: "new-build" },
          steps: [],
          durationMs: 0,
        },
        opts: { json: true, run },
        refreshServiceEnv,
        serviceEnv: { HOME: "/home/operator" },
        gatewayPort: 18789,
        restartScriptPath: "/tmp/openclaw-verification.sh",
        timeoutMs: 1_000,
        onVerified,
        onVerificationFailure,
      });
      expect(actual).toBe(verified ? "ok" : "restart-health-failed");
      expect(mocks.waitForGatewayHealthyRestart).toHaveBeenCalledTimes(1);
      expect(mocks.runRestartScript).toHaveBeenCalledTimes(refreshServiceEnv ? 0 : 1);
      expect(mocks.runUpdatedInstallGatewayCommand).toHaveBeenCalledTimes(
        refreshServiceEnv ? 1 : 0,
      );
      expect(onVerified).toHaveBeenCalledTimes(verified ? 1 : 0);
      expect(onVerificationFailure).toHaveBeenCalledTimes(verified ? 0 : 1);
      if (verified) {
        const verifiedAtMs = onVerified.mock.calls[0]?.[0];
        expect(verifiedAtMs).toBeGreaterThanOrEqual(startedAtMs);
        expect(verifiedAtMs).toBeLessThanOrEqual(Date.now());
      }
    },
  );

  it("rejects channel failures even when a Git target has no build identity", async () => {
    mocks.waitForGatewayHealthyRestart.mockResolvedValue({
      runtime: { status: "running", pid: 8000 },
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
      healthy: false,
      staleGatewayPids: [],
      channelProbeErrors: [{ id: "fixture", error: "channel startup failed" }],
      waitOutcome: "timeout",
    });
    const onVerificationFailure = vi.fn();
    await expect(
      maybeRestartService({
        shouldRestart: true,
        result: { status: "ok", mode: "git", steps: [], durationMs: 0 },
        opts: { json: true, run },
        refreshServiceEnv: false,
        serviceEnv: { HOME: "/home/operator" },
        gatewayPort: 18789,
        restartScriptPath: "/tmp/openclaw-verification.sh",
        timeoutMs: 1_000,
        onVerificationFailure,
      }),
    ).resolves.toBe("restart-health-failed");
    expect(onVerificationFailure).toHaveBeenCalledWith("channel-errors");
  });

  it("reports service ownership skips to JSON callers", async () => {
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);

    await expect(
      maybeRestartService({
        shouldRestart: false,
        result: {
          status: "ok",
          mode: "npm",
          steps: [],
          durationMs: 0,
        },
        opts: { json: true, run },
        refreshServiceEnv: false,
        gatewayPort: 18789,
        serviceMutationSkipMessage: "service management skipped: ownership conflict",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("ok");

    expect(errorSpy).toHaveBeenCalledWith("service management skipped: ownership conflict");
  });
});
