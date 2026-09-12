import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { GatewayServiceState } from "../../daemon/service.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { observeOriginalManagedServiceRuntime } from "./update-command-original-service.js";
import { finishUpdate } from "./update-command-post-update.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

// Native manager, HTTP and package transport are simulated. Execution, A observation,
// config/schema reads, compensation selection, finalizer and leases are real.
// This main composition has no capture producer. It is not migrated-worker proof.
const mocks = vi.hoisted(() => ({
  state: vi.fn<() => Promise<GatewayServiceState>>(),
  stop: vi.fn(),
  package: vi.fn(),
  restart: vi.fn(),
  health: vi.fn(),
  inspect: vi.fn(),
  running: true,
  windows: false,
  suspend: vi.fn(),
  resume: vi.fn(),
}));
vi.mock("../../daemon/schtasks.js", async (original) => ({
  ...(await original<typeof import("../../daemon/schtasks.js")>()),
  suspendScheduledTaskAutoStartForUpdate: mocks.suspend,
  resumeScheduledTaskAutoStartAfterUpdate: mocks.resume,
}));
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.state,
  resolveGatewayService: () => ({
    readCommand: async () => (await mocks.state()).command,
    readRuntime: async () => ({ status: mocks.running ? "running" : "stopped" }),
  }),
}));
vi.mock("./update-command-service.js", async (original) => ({
  ...(await original<typeof import("./update-command-service.js")>()),
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
}));
vi.mock("./update-command-package.js", async (original) => ({
  ...(await original<typeof import("./update-command-package.js")>()),
  runPackageInstallUpdate: mocks.package,
}));
vi.mock("./update-command-service-command.js", async (original) => ({
  ...(await original<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.restart,
}));
vi.mock("../daemon-cli/restart-health.js", async (original) => ({
  ...(await original<typeof import("../daemon-cli/restart-health.js")>()),
  inspectGatewayRestart: mocks.inspect,
  waitForGatewayHealthyRestart: mocks.health,
  waitForGatewayHttpReadiness: async () => ({ readyz: 200 }),
}));
vi.mock("./progress.js", async (original) => ({
  ...(await original<typeof import("./progress.js")>()),
  printResult: vi.fn(),
}));

let state: OpenClawTestState;
let serviceState: GatewayServiceState;
let rootA: string;
let rootB: string;
let before: PreManagedServiceStop;
let stopped = false;
const schemas = { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION };
beforeEach(async () => {
  vi.clearAllMocks();
  state = await createOpenClawTestState({
    label: "original-service",
    env: { OPENCLAW_UPDATE_RUN_ID: undefined, OPENCLAW_UPDATE_RUN_HANDOFF: undefined },
  });
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: state.home });
  delete state.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_HOME;
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
  });
  rootA = state.path("A");
  rootB = state.path("B");
  for (const [root, version] of [
    [rootA, "2026.9.3"],
    [rootB, "2026.9.4"],
  ]) {
    await fs.mkdir(path.join(root!, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root!, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version,
        type: "module",
        openclaw: { schemaVersions: schemas },
      }),
    );
    await fs.writeFile(path.join(root!, "dist", "index.js"), "export {};\n");
    await fs.writeFile(
      path.join(root!, "dist", "build-info.json"),
      JSON.stringify({ buildId: root === rootA ? "build-A" : "build-B" }),
    );
  }
  const coordinator = state.path("coordinator");
  await fs.mkdir(coordinator);
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(coordinator);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  serviceState = {
    installed: true,
    running: true,
    env: state.env,
    loadState: { status: "loaded" },
    command: {
      programArguments: [process.execPath, path.join(rootA, "dist", "index.js"), "gateway"],
      environment: Object.fromEntries(
        Object.entries(state.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    },
    runtime: { status: "running", pid: 4242, systemd: { managerUid: process.getuid?.() ?? 501 } },
  };
  mocks.state.mockImplementation(async () => ({
    ...serviceState,
    running: mocks.running,
    runtime: { ...serviceState.runtime, status: mocks.running ? "running" : "stopped" },
  }));
  before = {
    stopped: false,
    inspected: true,
    runtimeInspected: true,
    running: true,
    serviceEnv: state.env,
    serviceNodeRunner: process.execPath,
    serviceManagerUid: process.getuid?.() ?? 501,
    serviceUpdateVerdict: await revalidateManagedGatewayServiceAfterUpdate({
      state: serviceState,
      root: rootA,
    }),
  };
  stopped = false;
  mocks.running = true;
  mocks.windows = false;
  mocks.suspend.mockImplementation(async (_env, options) => {
    options.assertCurrent?.();
    await options.beforeMutation?.();
    return true;
  });
  mocks.resume.mockImplementation(async (_env, options) => {
    options.assertCurrent?.();
    await options.beforeMutation?.();
  });
  mocks.stop.mockImplementation(async ({ phase, shouldRestart, updateRun }) => {
    if (phase !== "inspect" && shouldRestart) {
      if (mocks.windows && !before.windowsTaskAutoStartRecovery) {
        before.windowsTaskAutoStartRecovery = createWindowsTaskAutoStartRecovery({
          serviceEnv: state.env,
          assertCurrent: () => updateRun.executorFence.assertCurrent(),
        });
        await before.windowsTaskAutoStartRecovery.suspended;
        before.windowsTaskAutoStartRecovery.beginMutation();
      }
      stopped = true;
      mocks.running = false;
    }
    return { ...before, stopped, running: !stopped };
  });
  mocks.inspect.mockImplementation(async ({ expectedVersion, expectedBuildId }) => ({
    healthy: true,
    runtime: { status: "running" },
    gatewayVersion: expectedVersion,
    gatewayBuildId: expectedBuildId,
  }));
  mocks.health.mockImplementation(async ({ expectedVersion, expectedBuildId }) => ({
    healthy: true,
    runtime: { status: "running" },
    gatewayVersion: expectedVersion,
    gatewayBuildId: expectedBuildId,
  }));
  mocks.restart.mockImplementation(async (params, action, preserve) => {
    params.assertCurrent();
    expect(action).toBe("restart");
    expect(preserve).toBe(true);
    expect(params.result.root).toBe(rootA);
    expect(params.nodeRunner).toBe(process.execPath);
    if (mocks.windows) {
      expect(mocks.resume).toHaveBeenCalledTimes(1);
    }
    mocks.running = true;
    return "accepted";
  });
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: "agent:main:before", env: state.env },
    { sessionId: "before", updatedAt: 1 },
  );
  await closeOpenClawAgentDatabasesAsync();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

it.each([
  "healthy",
  "same-version",
  "package-root-missing",
  "windows-autostart",
  "windows-autostart-health-failed",
  "schema-newer",
  "agent-support-older",
  "definition-changed",
  "node-changed",
  "package-changed",
  "authority-lost",
  "no-restart",
  "unverified",
  "readiness-failed",
] as const)("keeps B facts and current data through split-root failure: %s", async (scenario) => {
  mocks.windows = scenario.startsWith("windows-autostart");
  const run = {
    runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
    env: state.env,
  };
  const opts: UpdateCommandOptions = { json: true, run };
  if (scenario === "agent-support-older") {
    const packagePath = path.join(rootA, "package.json");
    const metadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
    metadata.openclaw.schemaVersions.agent = OPENCLAW_AGENT_SCHEMA_VERSION - 1;
    await fs.writeFile(packagePath, JSON.stringify(metadata));
  }
  const configSnapshot = await readConfigFileSnapshot();
  let newerAgentBytes: Buffer | undefined;
  let newerSharedBytes: Buffer | undefined;
  let candidatePackageBytes: Buffer | undefined;
  const configBefore = await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!);
  mocks.package.mockImplementation(async (params) => {
    await params.beforeActivate();
    await fs.writeFile(
      path.join(rootB, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: scenario === "same-version" ? "2026.9.4" : "2026.9.5",
        type: "module",
        openclaw: { schemaVersions: schemas },
      }),
    );
    candidatePackageBytes = await fs.readFile(path.join(rootB, "package.json"));
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:after", env: state.env },
      { sessionId: "newer", updatedAt: 2 },
    );
    await closeOpenClawAgentDatabasesAsync();
    newerAgentBytes = await fs.readFile(
      resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    );
    if (scenario === "schema-newer") {
      const db = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      newerSharedBytes = await fs.readFile(resolveOpenClawStateSqlitePath(state.env));
    }
    if (scenario === "definition-changed") {
      serviceState.command!.programArguments.push("--port", "19998");
    }
    if (scenario === "node-changed") {
      serviceState.command!.programArguments[0] = "/different/node";
    }
    if (scenario === "package-changed") {
      await fs.appendFile(path.join(rootA, "dist", "index.js"), "// replaced\n");
    }
    if (scenario === "package-root-missing") {
      await fs.rename(rootB, `${rootB}-displaced`);
    }
    if (scenario === "authority-lost") {
      const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
      db.prepare(
        "UPDATE managed_update_handoffs SET owner = 'replacement' WHERE install_root = ?",
      ).run(rootB);
      db.close();
    }
    return {
      status: "error",
      mode: "npm",
      root: rootB,
      reason: "named-plugin-failure",
      before: { version: "2026.9.4", buildId: "build-B" },
      after: {
        version: scenario === "same-version" ? "2026.9.4" : "2026.9.5",
        buildId: "candidate-B",
      },
      recovery: {
        serviceRestartSafe: false,
        reason: "deps-install-failed",
        packageRollbackVerified: false,
      },
      steps: [],
      durationMs: 1,
    };
  });
  if (scenario === "unverified") {
    mocks.inspect.mockResolvedValue({ healthy: false, runtime: { status: "running" } });
  }
  if (scenario === "readiness-failed" || scenario === "windows-autostart-health-failed") {
    mocks.health.mockResolvedValue({
      healthy: false,
      runtime: { status: "stopped" },
      staleGatewayPids: [],
      portUsage: { status: "free", port: 18789, listeners: [], hints: [] },
    });
  }
  let execution: Awaited<ReturnType<typeof executeMutableUpdate>> | undefined;
  let final: unknown;
  const work = withUpdateCommandExecutor(run.runId, async (executor) => {
    const fence = await executor.enter(rootB, { serviceRoot: rootA });
    const admitted = { ...run, executorFence: fence };
    opts.run = admitted;
    execution = await executeMutableUpdate({
      root: rootB,
      // Package transport is modeled; A must not use this separately selected B runner.
      packageUpdateNodeRunner: state.path("selected-B-node"),
      installKind: "package",
      updateInstallKind: "package",
      switchToGit: false,
      timeoutMs: 30000,
      updateStepTimeoutMs: 30000,
      startedAt: Date.now(),
      progress: {},
      stop: () => {},
      channel: "stable",
      tag: "2026.9.5",
      opts,
      shouldRestart: scenario !== "no-restart",
      packageInstallSpec: "openclaw@2026.9.5",
      packageTargetVersion: "2026.9.5",
      managedServiceRootRedirect: null,
      managedServiceRoot: rootA,
      recoveryState: { triageTarget: { env: state.env } },
      prepareMutableUpdate: async () => {
        fence.assertCurrent();
      },
    });
    if (scenario === "authority-lost") {
      fence.assertCurrent();
      return;
    }
    expect(execution?.previousVerified).toBe(false);
    expect(execution?.previousSchemaVersions).toEqual(schemas);
    expect(execution?.result.before).toEqual({ version: "2026.9.4", buildId: "build-B" });
    if (!execution) {
      throw new Error("missing execution");
    }
    final = await finishUpdate({
      ...execution,
      root: rootB,
      packageUpdateNodeRunner: state.path("selected-B-node"),
      installKindChanged: false,
      configSnapshot,
      requestedChannel: null,
      storedChannel: "stable",
      channel: "stable",
      downgradeRisk: false,
      shouldRestart: scenario !== "no-restart",
      opts,
      ownedManagedUpdateEnv: state.env,
      controlPlaneUpdateSentinelMeta: null,
      preUpdatePluginInstallRecords: {},
      startedAt: Date.now(),
      updateStepTimeoutMs: 30000,
    }).catch((error: unknown) => error);
    if (scenario === "schema-newer") {
      expect(final).toMatchObject({
        name: "UpdateCommandPendingRecoveryFailure",
        exitCode: 1,
        cause: { kind: "newer-schema" },
        automaticTriage: undefined,
        result: {
          root: rootB,
          status: "error",
          reason: "named-plugin-failure",
          recovery: { serviceRestartSafe: false },
        },
      });
      return;
    }
    expect(final).toMatchObject({
      result: {
        status: "error",
        root: rootB,
        reason: "named-plugin-failure",
        before: { version: "2026.9.4" },
        after: { buildId: "candidate-B" },
        recovery: {
          serviceRestartSafe: false,
          reason: "deps-install-failed",
          packageRollbackVerified: false,
        },
      },
    });
  });
  if (scenario === "authority-lost") {
    await expect(work).rejects.toThrow();
  } else {
    await work;
  }
  const healthy = ["healthy", "same-version", "package-root-missing", "windows-autostart"].includes(
    scenario,
  );
  expect(mocks.restart).toHaveBeenCalledTimes(
    healthy || scenario === "readiness-failed" || scenario === "windows-autostart-health-failed"
      ? 1
      : 0,
  );
  if (scenario !== "authority-lost") {
    expect(execution?.originalManagedServiceRuntime).toMatchObject({
      root: rootA,
      version: "2026.9.3",
      verified: scenario !== "unverified",
    });
  }
  if (healthy) {
    expect(mocks.health).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "2026.9.3", expectedBuildId: "build-A" }),
    );
  }
  if (scenario === "schema-newer") {
    expect(
      await fs.readFile(resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env })),
    ).toEqual(newerAgentBytes);
  } else {
    expect(
      loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey: "agent:main:after",
        env: state.env,
      }),
    ).toMatchObject({ sessionId: "newer" });
  }
  if (mocks.windows) {
    expect(mocks.suspend).toHaveBeenCalledTimes(scenario === "windows-autostart" ? 1 : 2);
    expect(mocks.resume).toHaveBeenCalledTimes(1);
  }
  expect(
    await fs.readFile(
      path.join(scenario === "package-root-missing" ? `${rootB}-displaced` : rootB, "package.json"),
    ),
  ).toEqual(candidatePackageBytes);
  expect(await fs.readFile(state.env.OPENCLAW_CONFIG_PATH!)).toEqual(configBefore);
  expect(execution).not.toHaveProperty("updateRecoveryBackup");
  if (scenario === "schema-newer") {
    // Do not reopen the newer schema using this runtime to make an assertion.
    expect(await fs.readFile(resolveOpenClawStateSqlitePath(state.env))).toEqual(newerSharedBytes);
  } else {
    expect(
      loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey: "agent:main:before",
        env: state.env,
      }),
    ).toMatchObject({ sessionId: "before" });
  }
});

it("refuses B ledger admission independently from compatible service A state", async () => {
  const parentDir = state.path("parent-state");
  await fs.mkdir(parentDir);
  const parentEnv = {
    ...state.env,
    OPENCLAW_STATE_DIR: parentDir,
    OPENCLAW_CONFIG_PATH: path.join(parentDir, "openclaw.json"),
  };
  await fs.writeFile(
    parentEnv.OPENCLAW_CONFIG_PATH,
    JSON.stringify({ plugins: { enabled: false } }),
  );
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env: parentEnv }).runId,
    env: parentEnv,
  };
  await withUpdateCommandExecutor(run.runId, async (executor) => {
    run.executorFence = await executor.enter(rootB, { serviceRoot: rootA });
    const opts: UpdateCommandOptions = { json: true, run };
    const original = await observeOriginalManagedServiceRuntime({ root: rootB, opts }, before);
    expect(original?.verified).toBe(true);
    const db = new DatabaseSync(resolveOpenClawStateSqlitePath(parentEnv));
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const parentBytes = await fs.readFile(resolveOpenClawStateSqlitePath(parentEnv));
    const compensation = rollbackFailedUpdate({
      result: { status: "error", mode: "npm", root: rootB, steps: [], durationMs: 0 },
      previousRoot: rootB,
      previousSchemaVersions: schemas,
      originalManagedServiceRuntime: original,
      configSnapshot: await readConfigFileSnapshot(),
      opts,
      preManagedServiceStop: before,
      allowGatewayRestart: false,
      timeoutMs: 30000,
    });
    // Main's existing admission checks A and B before selecting compensation.
    await expect(compensation).resolves.toMatchObject({
      rolledBack: false,
      pendingRecoveryReason: expect.any(String),
      result: { status: "error", recovery: { serviceRestartSafe: false } },
    });
    expect(await fs.readFile(resolveOpenClawStateSqlitePath(parentEnv))).toEqual(parentBytes);
  });
  expect(mocks.restart).not.toHaveBeenCalled();
});
