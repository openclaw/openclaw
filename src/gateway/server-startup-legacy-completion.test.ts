import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import type { GatewayServer } from "./server-public.js";

const installed = vi.hoisted(() => ({ root: "", buildId: "legacy-automatic-completion" }));
vi.mock("../infra/openclaw-root.js", async (original) => {
  const actual = await original<typeof import("../infra/openclaw-root.js")>();
  return {
    ...actual,
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
vi.mock("../version.js", async (original) => ({
  ...(await original<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildId: () => installed.buildId,
}));

vi.mock("../update/run.js", async (original) => ({
  ...(await original<typeof import("../update/run.js")>()),
  runPluginMaintenance: async () => ({ step: { step: "plugins", status: "completed" as const } }),
}));
vi.mock("../cli/update-cli/update-command-post-activation-inspections.js", async (original) => ({
  ...(await original<
    typeof import("../cli/update-cli/update-command-post-activation-inspections.js")
  >()),
  runPostActivationInspections: async ({
    result,
  }: Parameters<
    typeof import("../cli/update-cli/update-command-post-activation-inspections.js").runPostActivationInspections
  >[0]) => result,
}));

it("automatically completes the original Git update when its healthy schema-40 verifier removes the trial before refusing history", async ({
  signal,
}) => {
  const fixture = await import("./server-startup-state.test-support.js");
  const state = await fixture.createGatewayStartupTestState("legacy-automatic-completion", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
    OPENCLAW_LAUNCHER_IPC: "",
    OPENCLAW_SKIP_CHANNELS: undefined,
    OPENCLAW_SKIP_PROVIDERS: undefined,
  });
  state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
  state.applyEnv();
  const prefix = state.statePath("git-install");
  installed.root = path.join(prefix, "releases", "candidate", "openclaw");
  await fs.mkdir(path.join(installed.root, "dist"), { recursive: true });
  await fs.symlink(
    process.platform === "win32" ? installed.root : path.relative(prefix, installed.root),
    path.join(prefix, "openclaw"),
    "junction",
  );
  vi.resetModules();
  const { VERSION } = await import("../version.js");
  await fs.writeFile(
    path.join(installed.root, "package.json"),
    JSON.stringify({ name: "openclaw", version: VERSION }),
  );
  await fs.writeFile(
    path.join(installed.root, "dist", "build-info.json"),
    JSON.stringify({ version: VERSION, buildId: installed.buildId }),
  );
  const receipt = {
    target: "releases/candidate/openclaw",
    previous: "releases/previous/openclaw",
    version: VERSION,
    buildId: installed.buildId,
    createdAt: Date.now(),
  };
  const trialPath = path.join(prefix, "releases", ".trial");
  await fs.writeFile(trialPath, JSON.stringify({ ...receipt, attempts: 1 }));
  const driver = fork(path.resolve("src/gateway/legacy-schema40-driver.test-support.ts"), [], {
    execArgv: process.versions.bun
      ? []
      : ["--import", pathToFileURL(path.resolve("scripts/tsx.mjs")).href],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: process.env,
  });
  let stderr = "";
  driver.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(driver, "close");
  const ready = Promise.race([
    once(driver, "message"),
    exited.then(() => {
      throw new Error("Driver exited before admission: " + stderr);
    }),
  ]);
  let server: GatewayServer | undefined;
  let releaseObserver: (() => void) | undefined;
  try {
    await ready;
    const { readUpdateRunDriver, inspectUpdateRunDriver } =
      await import("../infra/update-run-driver.js");
    const identity = readUpdateRunDriver(driver.pid);
    expect(identity).toBeDefined();
    expect(inspectUpdateRunDriver(identity!)).toBe("alive");
    const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
      await import("../state/openclaw-state-db.js");
    const { resolveOpenClawStateSqlitePath } = await import("../state/openclaw-state-db.paths.js");
    const { createUpdateRunAsync, recordUpdateRunPhaseAsync } =
      await import("../infra/update-run-write.async.js");
    const { getUpdateRunAsync, listUpdateRunsAsync } =
      await import("../infra/update-run-reader.js");
    openOpenClawStateDatabase();
    const run = await createUpdateRunAsync({
      trigger: "cli",
      target: { kind: "git" },
      origin: { driver: identity },
    });
    await recordUpdateRunPhaseAsync(run.runId, "restarting");
    const { prepareLegacyTrialRun } = await import("../update/legacy-trial.js");
    await prepareLegacyTrialRun(run.runId, installed.root, () => {});
    await closeOpenClawStateDatabaseAsync();
    const { createGatewaySchedulerClock } =
      await import("../test-utils/gateway-scheduler-clock.js");
    const clock = createGatewaySchedulerClock();
    const schedulerModule = await import("../infra/gateway-scheduler.js");
    const Scheduler = schedulerModule.GatewayScheduler;
    vi.spyOn(schedulerModule, "GatewayScheduler").mockImplementation(function (options = {}) {
      return new Scheduler({ ...options, clock: clock.clock });
    });
    const { registerGatewayRunInstallationReplacement } =
      await import("../cli/gateway-cli/run-loop-request.js");
    releaseObserver = registerGatewayRunInstallationReplacement({
      waitForUpdates: () => undefined,
      accept: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() },
      supervised: true,
    });
    const { getFreePort } = await import("../test-utils/ports.js");
    const port = await getFreePort();
    const token = "legacy-automatic-completion-token";
    await state.writeConfig({
      gateway: fixture.gatewayStartupTestConfig(port, token),
      plugins: { enabled: false },
      discovery: { mdns: { mode: "off" } },
    });
    const { startGatewayServerCore } = await import("./server-start.js");
    server = await startGatewayServerCore(port, {
      ...fixture.gatewayStartupTestOptions(token),
      sidecarStartup: "start",
    });
    const { waitForGatewayHttpReadiness } =
      await import("../cli/daemon-cli/restart-health-probe.js");
    expect(
      await waitForGatewayHttpReadiness({
        port,
        attempts: 100,
        deadlineAt: performance.now() + 5_000,
        delayMs: 50,
        requireChannelHealth: false,
        signal,
      }),
    ).toMatchObject({ coreReady: true, healthz: 200, readyz: 503 });
    expect(inspectUpdateRunDriver(identity!)).toBe("alive");
    expect(await fs.readFile(trialPath, "utf8")).toBe(JSON.stringify({ ...receipt, attempts: 1 }));
    driver.send({
      databasePath: resolveOpenClawStateSqlitePath(),
      runningRoot: path.join(prefix, "openclaw"),
    });
    expect((await exited)[0]).toBe(1);
    expect(stderr).toMatch(/uses newer schema version \d+; this build supports 40/u);
    expect(inspectUpdateRunDriver(identity!)).toBe("dead");
    const { reconcileAbandonedUpdateRunsAsync } =
      await import("../infra/update-run-reconciliation.js");
    await reconcileAbandonedUpdateRunsAsync({ runIds: [run.runId] });
    expect(await getUpdateRunAsync(run.runId)).toMatchObject({
      status: "failed",
      reason: "abandoned",
      after: {},
      verification: {},
    });
    expect((await getUpdateRunAsync(run.runId))?.steps).toContainEqual(
      expect.objectContaining({ step: "reconcile:abandoned", detail: "inactive-driver-dead" }),
    );
    await expect(fs.stat(trialPath)).rejects.toMatchObject({ code: "ENOENT" });
    const { TICK_INTERVAL_MS } = await import("./server-constants.js");
    await clock.advanceBy(TICK_INTERVAL_MS);
    await clock.advanceBy(TICK_INTERVAL_MS);
    await expect
      .poll(() => getUpdateRunAsync(run.runId))
      .toMatchObject({
        status: "succeeded",
        reason: null,
        after: { version: VERSION, buildId: installed.buildId },
        verification: {
          booted: true,
          coreReady: true,
          runningVersion: VERSION,
          runningBuildId: installed.buildId,
        },
      });
    const { readUpdateRunStatusWithOwedSteps } = await import("../infra/update-run-status.js");
    const status = await readUpdateRunStatusWithOwedSteps(() => {});
    expect(status).not.toHaveProperty("runStatusError");
    if (!("lastRun" in status) || !status.lastRun) {
      throw new Error("Expected the original update in status");
    }
    expect(status.abandonedRun).toBeUndefined();
    expect(status.staleRun).toBeUndefined();
    expect(status.lastRun?.origin.nextAction).toBeUndefined();
    const { renderUpdateRunSummary } = await import("../infra/update-run-notice.js");
    expect(renderUpdateRunSummary(status.lastRun)).not.toContain("update repair");
    await expect(fs.stat(trialPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.realpath(path.join(prefix, "openclaw"))).toBe(installed.root);
    expect((await listUpdateRunsAsync({ limit: 10 })).map((entry) => entry.runId)).toEqual([
      run.runId,
    ]);
  } finally {
    if (driver.exitCode === null && driver.signalCode === null) {
      driver.kill();
    }
    await exited;
    await server?.close();
    releaseObserver?.();
    vi.restoreAllMocks();
    await state.cleanup();
  }
});
