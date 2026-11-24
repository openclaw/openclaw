import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { GatewayServer } from "./server-public.js";

const installed = vi.hoisted(() => ({
  root: "",
  buildId: "legacy-startup-ordering-build",
  degraded: true,
  port: 0,
}));
vi.mock("../infra/openclaw-root.js", async (original) => {
  const actual = await original<typeof import("../infra/openclaw-root.js")>();
  return {
    ...actual,
    resolveOpenClawPackageRoot: (
      options: Parameters<typeof actual.resolveOpenClawPackageRoot>[0],
    ) =>
      options?.moduleUrl?.includes("update-run-interruption-health.")
        ? Promise.resolve(installed.root)
        : actual.resolveOpenClawPackageRoot(options),
    resolveOpenClawPackageRootSync: (
      options: Parameters<typeof actual.resolveOpenClawPackageRootSync>[0],
    ) =>
      options?.moduleUrl?.includes("stale-install.")
        ? installed.root
        : actual.resolveOpenClawPackageRootSync(options),
  };
});
vi.mock("./server-channels.js", async (original) => {
  const actual = await original<typeof import("./server-channels.js")>();
  return {
    ...actual,
    createChannelManager: (options: Parameters<typeof actual.createChannelManager>[0]) => {
      const manager = actual.createChannelManager(options);
      const snapshot = manager.getRuntimeSnapshot;
      return {
        ...manager,
        getRuntimeSnapshot: () => {
          const current = snapshot();
          if (!installed.degraded) {
            return current;
          }
          return {
            ...current,
            channelAccounts: {
              ...current.channelAccounts,
              "unavailable-test-channel": {
                default: { accountId: "default", enabled: true, configured: true, running: false },
              },
            },
          };
        },
      };
    },
  };
});
vi.mock("../daemon/service.js", async (original) => {
  const actual = await original<typeof import("../daemon/service.js")>();
  return {
    ...actual,
    resolveGatewayService: () => ({
      ...actual.resolveGatewayService(),
      readRuntime: async () => ({ status: "running" as const, pid: process.pid }),
      readCommand: async () => ({
        programArguments: [
          process.execPath,
          path.join(installed.root, "dist/index.js"),
          "gateway",
          "--port",
          String(installed.port),
        ],
      }),
    }),
  };
});
vi.mock("../version.js", async (original) => ({
  ...(await original<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildId: () => installed.buildId,
}));

it.each([
  { name: "core ready before channel health", captureBeforeReady: false, changedRow: false },
  { name: "ready receipt after repair capture", captureBeforeReady: true, changedRow: false },
  { name: "changed-row refusal", captureBeforeReady: true, changedRow: true },
])(
  "settles the actual cold-started legacy build through repair: $name",
  async ({ captureBeforeReady, changedRow }) => {
    installed.degraded = !captureBeforeReady;
    const fixture = await import("./server-startup-state.test-support.js");
    const { getFreePort } = await import("../test-utils/ports.js");
    const { createGatewaySchedulerClock } =
      await import("../test-utils/gateway-scheduler-clock.js");
    const state = await fixture.createGatewayStartupTestState("legacy-startup-ordering", {
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      OPENCLAW_LAUNCHER_IPC: "",
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
    });
    state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
    const prefix = state.statePath("git-install");
    installed.root = path.join(prefix, "releases", "candidate", "openclaw");
    await fs.mkdir(path.join(installed.root, "dist"), { recursive: true });
    await fs.symlink(installed.root, path.join(prefix, "openclaw"), "junction");
    vi.resetModules();
    state.applyEnv();
    const { VERSION } = await import("../version.js");
    await fs.writeFile(
      path.join(installed.root, "package.json"),
      JSON.stringify({ name: "openclaw", version: VERSION }),
    );
    await fs.writeFile(
      path.join(installed.root, "dist", "build-info.json"),
      JSON.stringify({ version: VERSION, buildId: installed.buildId }),
    );
    const trial = {
      target: "releases/candidate/openclaw",
      previous: "releases/previous/openclaw",
      version: VERSION,
      buildId: installed.buildId,
      createdAt: Date.now(),
      attempts: 1,
    };
    const trialPath = path.join(prefix, "releases", ".trial");
    await fs.writeFile(trialPath, JSON.stringify(trial));
    const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
      await import("../state/openclaw-state-db.js");
    openOpenClawStateDatabase();
    const { createUpdateRunAsync, recordUpdateRunPhaseAsync } =
      await import("../infra/update-run-write.async.js");
    const { getUpdateRunAsync } = await import("../infra/update-run-reader.js");
    const { deadDriverFixture } = await import("../infra/update-run-fixture.test-support.js");
    const { prepareLegacyTrialRun } = await import("../update/legacy-trial.js");
    const run = await createUpdateRunAsync({
      trigger: "cli",
      target: { kind: "git" },
      origin: { driver: deadDriverFixture().dead },
    });
    await recordUpdateRunPhaseAsync(run.runId, "restarting");
    await prepareLegacyTrialRun(run.runId, installed.root, () => {});
    await closeOpenClawStateDatabaseAsync();
    const clock = createGatewaySchedulerClock();
    const schedulerModule = await import("../infra/gateway-scheduler.js");
    const Scheduler = schedulerModule.GatewayScheduler;
    vi.spyOn(schedulerModule, "GatewayScheduler").mockImplementation(function (options = {}) {
      return new Scheduler({ ...options, clock: clock.clock });
    });
    const { registerGatewayRunInstallationReplacement } =
      await import("../cli/gateway-cli/run-loop-request.js");
    const releaseObserver = registerGatewayRunInstallationReplacement({
      waitForUpdates: () => undefined,
      accept: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() },
      supervised: true,
    });
    const port = await getFreePort();
    installed.port = port;
    const token = "legacy-startup-ordering-token";
    let server: GatewayServer | undefined;
    try {
      await state.writeConfig({
        gateway: fixture.gatewayStartupTestConfig(port, token),
        plugins: { enabled: false },
        discovery: { mdns: { mode: "off" } },
      });
      const { reconcileAbandonedUpdateRunsAsync } =
        await import("../infra/update-run-reconciliation.js");
      await reconcileAbandonedUpdateRunsAsync({ runIds: [run.runId] });
      const { prepareUpdateRepairHistory } = await import("../update/repair-history.js");
      const capturedHistory = captureBeforeReady
        ? prepareUpdateRepairHistory([run.runId])
        : undefined;
      if (changedRow) {
        const { recordUpdateRunStepAsync } = await import("../infra/update-run-write.async.js");
        await recordUpdateRunStepAsync(run.runId, {
          step: "post-activation doctor inspections",
          status: "completed",
        });
      }
      const { startGatewayServerCore } = await import("./server-start.js");
      server = await startGatewayServerCore(port, {
        ...fixture.gatewayStartupTestOptions(token),
        sidecarStartup: "start",
      });
      await server.startupSettled;
      const response = await fetch("http://127.0.0.1:" + port + "/readyz");
      expect(response.status).toBe(installed.degraded ? 503 : 200);
      expect(await response.json()).toMatchObject({
        ready: !installed.degraded,
        coreReady: true,
        failing: installed.degraded ? ["unavailable-test-channel"] : [],
      });
      expect((await getUpdateRunAsync(run.runId))?.steps).toContainEqual(
        expect.objectContaining({ step: "finalize:legacy-release-ready", status: "completed" }),
      );
      await expect(fs.stat(trialPath)).rejects.toMatchObject({ code: "ENOENT" });
      const settleHistory = capturedHistory ?? prepareUpdateRepairHistory([run.runId]);
      const { UpdateFinalizationLifecycle } =
        await import("../cli/update-cli/update-finalization-lifecycle.js");
      const lifecycle = new UpdateFinalizationLifecycle(true, undefined, () => {}, false);
      const repairId = lifecycle.attachLedger(true, false);
      const { withUpdateCommandExecutor } =
        await import("../cli/update-cli/update-command-executor.js");
      await withUpdateCommandExecutor(repairId, async (executor) => {
        const authority = await executor.enter(installed.root);
        for (const phase of ["doctor", "plugins", "targetConfigConvergence"] as const) {
          await lifecycle.run(phase, async (admission) => {
            admission.assertCurrent();
            authority.assertCurrent();
          });
        }
        expect(await settleHistory(repairId, installed.root, true)).toEqual(
          changedRow ? [] : [run.runId],
        );
      });
      lifecycle.complete(0);
      const original = await getUpdateRunAsync(run.runId);
      if (changedRow) {
        expect(original).toMatchObject({ status: "failed", reason: "abandoned", after: {} });
        expect(original?.steps.some((step) => step.step === "reconcile:acknowledged")).toBe(false);
        return;
      }
      expect(original).toMatchObject({
        status: "succeeded",
        reason: null,
        after: { version: VERSION, buildId: installed.buildId },
        verification: {
          runningVersion: VERSION,
          runningBuildId: installed.buildId,
          booted: true,
          coreReady: true,
          serviceRunning: true,
          settled: true,
        },
      });
    } finally {
      await server?.close();
      releaseObserver();
      vi.restoreAllMocks();
      await state.cleanup();
    }
  },
);
