import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  gatewayCommandCall,
  gatewayHealthCall,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  gatewayFixturePid,
  pathExists,
  restartHealthTestControl,
  serviceLoaded,
  serviceRestart,
  serviceStart,
  serviceStop,
  triageCommand,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  doctorCommand,
  ExitError,
  listUpdateRuns,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  resolveGatewayInstallEntrypoint,
  runDaemonInstall,
  runDaemonRestart,
  runUpdateFailureTriage,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  mockUnbuiltRecoveryFixture,
  recoveryVerificationStep,
  recoveryVersionMismatch,
} from "./update-cli/update-cli-failure-recovery.test-support.js";
import { writeJsonFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseSnapshot,
    createCaseDir,
    initializeExistingUpdateProfile,
    mockGatewayHealth,
    mockGatewayInstallFailure,
    mockOwnedGitService,
    mockPackageInstallAtCaseDir,
    mockRunningManagedGateway,
    primeServiceCommand,
    profileStateDir,
    runRestartFallbackScenario,
    runUpdateCliScenario,
    setStdoutTty,
    setTty,
    setupNpmUpdatedRootRefresh,
    setupUpdatedRootRefresh,
    tempDirsToCleanup,
  } = createUpdateCliFixture();

  it.each(["success", "failure"] as const)(
    "starts interactive update triage after cleanup and preserves update status after agent %s",
    async (agentOutcome) => {
      await mockUnbuiltRecoveryFixture();
      setTty(true);
      setStdoutTty(true);
      const stateDir = profileStateDir("update-triage");
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
      tempDirsToCleanup.add(stateDir);
      await fs.mkdir(stateDir, { recursive: true });
      const target = {
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        defaultWorkspaceDir: path.join(stateDir, "workspace"),
      };
      const operatorPath = `${path.join(stateDir, "coding-tools")}${path.delimiter}${process.env.PATH}`;
      const operatorNodeOptions = "--max-old-space-size=1024";
      await writeJsonFixture(target.configPath, baseSnapshot.config);
      const update: UpdateRunResult = {
        status: "error",
        mode: "git",
        root: process.cwd(),
        reason: "doctor-failed",
        before: { version: "1.0.0" },
        after: { version: "1.1.0" },
        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
        steps: [],
        durationMs: 100,
      };
      mockRunningManagedGateway(["node", path.join(process.cwd(), "dist", "index.js"), "gateway"]);
      mockOwnedGitService();
      primeServiceCommand(
        [process.execPath, path.join(process.cwd(), "dist", "index.js"), "gateway"],
        {
          PATH: "/usr/bin:/bin",
          NODE_OPTIONS: "",
          OPENCLAW_PROFILE: "update-triage",
          OPENCLAW_STATE_DIR: target.stateDir,
          OPENCLAW_CONFIG_PATH: target.configPath,
          OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
        },
      );
      mockGitUpdateAfterMutation(update);
      let triageEnv: Record<string, string | undefined> | undefined;
      const events: string[] = [];
      triageCommand.mockImplementationOnce(async () => {
        events.push("triage");
        triageEnv = {
          updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS,
          stateDir: process.env.OPENCLAW_STATE_DIR,
          configPath: process.env.OPENCLAW_CONFIG_PATH,
          defaultWorkspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
          path: process.env.PATH,
          nodeOptions: process.env.NODE_OPTIONS,
        };
        if (agentOutcome === "failure") {
          throw new ExitError(2);
        }
      });

      await withEnvAsync(
        {
          OPENCLAW_PROFILE: "update-triage",
          OPENCLAW_STATE_DIR: target.stateDir,
          OPENCLAW_CONFIG_PATH: target.configPath,
          OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          PATH: operatorPath,
          NODE_OPTIONS: operatorNodeOptions,
        },
        async () => {
          await expect(
            updateCommand({}).catch((error: unknown) => {
              events.push("exit");
              throw error;
            }),
          ).rejects.toEqual(new ExitError(1));
          expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
        },
      );

      expect(triageCommand).toHaveBeenCalledOnce();
      expect(triageEnv).toEqual({
        updateInProgress: undefined,
        ...target,
        path: operatorPath,
        nodeOptions: operatorNodeOptions,
      });
      expect(triageCommand.mock.calls[0]?.[1]).toMatchObject({
        recovery: {
          target,
          updateFailure: {
            result: {
              status: "error",
              mode: "git",
              root: process.cwd(),
              reason: "doctor-failed",
              before: update.before,
              after: update.after,
              recovery: update.recovery,
              steps: [recoveryVerificationStep([recoveryVersionMismatch])],
            },
          },
        },
      });
      expect(serviceStop, `${getLogOutput()}\n${getErrorOutput()}`).toHaveBeenCalledOnce();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(events).toEqual(["triage", "exit"]);
    },
  );

  it.each([
    { name: "JSON", options: { json: true }, stdin: true, stdout: true, success: false },
    {
      name: "non-interactive --yes",
      options: { yes: true },
      stdin: true,
      stdout: true,
      success: false,
    },
    { name: "piped input", options: {}, stdin: false, stdout: true, success: false },
    { name: "piped output", options: {}, stdin: true, stdout: false, success: false },
    { name: "successful update", options: {}, stdin: true, stdout: true, success: true },
  ])(
    "does not automatically launch update triage for $name",
    async ({ options, stdin, stdout, success }) => {
      setTty(stdin);
      setStdoutTty(stdout);
      vi.mocked(updateGitCheckout).mockResolvedValue(
        makeOkUpdateResult({
          status: success ? "ok" : "error",
          root: process.cwd(),
          ...(success
            ? {}
            : {
                reason: "doctor-failed",
                recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
              }),
        }),
      );

      if (success) {
        await updateCommand(options);
      } else {
        await expect(updateCommand(options)).rejects.toEqual(new ExitError(1));
      }

      expect(triageCommand).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(runUpdateFailureTriage).toHaveBeenCalledTimes(success ? 0 : 1);
    },
  );

  it.each(["error", "skipped"] as const)("explains edited files (%s)", async (status) => {
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();
    vi.mocked(updateGitCheckout).mockResolvedValue({
      status,
      mode: "git",
      reason: "dirty",
      steps: [],
      durationMs: 100,
    } satisfies UpdateRunResult);

    await expect(updateCommand({ channel: "dev" })).rejects.toEqual(new ExitError(1));

    const logs = getLogOutput();
    expect(logs).toContain(`OpenClaw update ${status === "error" ? "failed" : "skipped"}: dirty.`);
    expect(logs).toContain(
      "Local changes prevented this update before installation. Your checkout was preserved.",
    );
    expect(logs).toContain("Commit your changes and retry, or run `openclaw triage` for help.");
    expect(listUpdateRuns({ limit: 1 })[0]?.origin.nextAction).toContain(
      "Commit your changes and retry",
    );
    expect(serviceStop).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: "refreshes service env when already installed",
      run: async () => {
        await runRestartFallbackScenario({ daemonInstall: "ok" });
      },
      assert: () => {
        const install = gatewayCommandCall(path.join(process.cwd(), "dist", "index.js"), "install");
        expect(install?.[0]).toEqual(
          expect.arrayContaining(["gateway", "install", "--force", "--json"]),
        );
        expect(freshRestartCalls()).toHaveLength(1);
        expectNoSideEffects(runDaemonInstall, runDaemonRestart);
        expect(getLogOutput()).toContain("Gateway: restarted and verified.");
      },
    },
    {
      name: "uses the installed Git CLI when service env refresh cannot complete",
      run: async () => {
        await runRestartFallbackScenario({ daemonInstall: "fail" });
      },
      assert: () => {
        expectNoSideEffects(runDaemonInstall, runDaemonRestart);
      },
    },
    {
      name: "refuses a running Git installation with --no-restart",
      run: async () => {
        mockGitUpdateAfterMutation();
        serviceLoaded.mockResolvedValue(true);
        mockOwnedGitService();

        await expect(updateCommand({ restart: false })).rejects.toEqual(new ExitError(1));
      },
      assert: () => {
        expectNoSideEffects(runDaemonInstall, runDaemonRestart, serviceStop);
        expect(freshRestartCalls()).toHaveLength(0);
        expect(
          gatewayCommandCall(path.join(process.cwd(), "dist", "index.js"), "install"),
        ).toBeUndefined();
        expect(getErrorOutput()).toContain("still running");
      },
    },
    {
      name: "skips success message when restart does not run",
      run: async () => {
        vi.mocked(updateGitCheckout).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(runDaemonRestart).mockResolvedValue(false);
        vi.mocked(defaultRuntime.log).mockClear();
        await updateCommand({ restart: true });
      },
      assert: () => {
        const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(logLines.some((line) => line.includes("Daemon restarted successfully."))).toBe(
          false,
        );
        expect(logLines.some((line) => line.includes("Gateway: restarted and verified."))).toBe(
          false,
        );
      },
    },
  ] as const)("updateCommand service refresh behavior: $name", runUpdateCliScenario);

  it("reports activation failure when the updated CLI entrypoint is missing", async () => {
    const root = await mockPackageInstallAtCaseDir();
    mockRunningManagedGateway(["node", path.join(root, "dist", "index.js"), "gateway", "run"]);
    vi.mocked(resolveGatewayInstallEntrypoint).mockReset().mockResolvedValue(undefined);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(serviceStart).not.toHaveBeenCalled();
    expect(freshRestartCalls().length).toBe(0);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "tries the updated install restart when package service refresh fails (JSON: %s)",
    async (json) => {
      const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
      serviceLoaded.mockResolvedValue(true);
      primeServiceCommand(["node", updatedEntrypoint, "gateway", "run"]);
      mockGatewayInstallFailure(updatedEntrypoint, json ? "runtime warning" : undefined);
      mockGatewayHealth("2026.4.24", "updated-gateway");

      await updateCommand({ yes: true, json });

      expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
      const restartCall = gatewayCommandCall(updatedEntrypoint, "restart");
      expect(restartCall?.[0].slice(4)).toEqual([
        "--preserve-definition",
        "--json",
        "--update-executor",
        "run",
      ]);
      expect(restartCall?.[1].cwd).toBe(updatedRoot);
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      if (json) {
        expect(getErrorOutput()).toContain(
          "SERVICE_DEFINITION_UNKNOWN: Service definition refresh failed; the previous definition was restored: Error: launchctl bootstrap failed",
        );
      } else {
        expect(getLogOutput()).toContain("Gateway: restarted and verified.");
      }
    },
  );

  it("accepts same-version refresh failure recovery when the managed service restarts", async () => {
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    const updatedPackageJson = path.join(updatedRoot, "package.json");
    setupUpdatedRootRefresh({
      entrypoints: [updatedEntrypoint],
      targetVersion: "2026.4.24",
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.24" },
          after: { version: "2026.4.24" },
        }),
    });
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === updatedEntrypoint || candidate === updatedPackageJson,
    );
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", updatedEntrypoint, "gateway", "run"]);
    mockGatewayInstallFailure(updatedEntrypoint);
    mockGatewayHealth("2026.4.24", "matching-old-gateway");

    await updateCommand({ yes: true });

    expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeDefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("warns without restarting a stale same-version service when installation reconciliation fails", async () => {
    const oldRoot = createCaseDir("openclaw-old-root");
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const oldEntrypoint = path.join(oldRoot, "dist", "entry.js");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [oldEntrypoint, updatedEntrypoint],
      targetVersion: "2026.4.24",
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.24" },
          after: { version: "2026.4.24" },
        }),
    });
    serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", oldEntrypoint, "gateway", "run"]);
    mockGatewayInstallFailure(updatedEntrypoint);
    mockGatewayHealth("2026.4.24", "matching-old-service");

    await updateCommand({ yes: true });

    expect(gatewayCommandCall(updatedEntrypoint, "install")?.[0]).toContain("--force");
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeUndefined();
    expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    expect(freshRestartCalls()).toHaveLength(0);
    expect(getErrorOutput()).toContain(`Failed to reconcile gateway service with ${updatedRoot}`);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("fails a JSON package update when fallback restart leaves the old gateway running", async () => {
    const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    serviceLoaded.mockResolvedValue(true);
    mockGatewayHealth("2026.4.23", "old-gateway");

    await expect(updateCommand({ yes: true, json: true, timeout: "123" })).rejects.toEqual(
      new ExitError(1),
    );

    expectNoSideEffects(runDaemonRestart);
    const restartCall = gatewayCommandCall(updatedEntrypoint, "restart");
    expect(restartCall?.[0][0]).toContain("node");
    expect(restartCall?.[0].slice(4)).toEqual([
      "--preserve-definition",
      "--json",
      "--update-executor",
      "run",
    ]);
    expect(restartCall?.[1].cwd).toBe(updatedRoot);
    expect(restartCall?.[1].timeoutMs).toBe(123_000);
    expect(gatewayHealthCall()).toMatchObject({ method: "health", scopes: ["operator.read"] });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "version-mismatch" });
    expect(getErrorOutput()).toContain(
      "Gateway version mismatch: expected 2026.4.24, running gateway reported 2026.4.23.",
    );
    expect(doctorCommand).not.toHaveBeenCalled();
  });

  it("shows the matching-version probe failure when a JSON package update restart stays unhealthy", async () => {
    setupNpmUpdatedRootRefresh();
    serviceLoaded.mockResolvedValue(true);
    restartHealthTestControl.snapshot = {
      runtime: { status: "running", pid: gatewayFixturePid },
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: gatewayFixturePid, command: "openclaw-gateway" }],
        hints: [],
      },
      healthy: false,
      staleGatewayPids: [],
      gatewayVersion: "2026.4.24",
      expectedVersion: "2026.4.24",
      probeError: "timeout",
      waitOutcome: "timeout",
      elapsedMs: 60_000,
    };

    await expect(updateCommand({ yes: true, json: true, timeout: "123" })).rejects.toEqual(
      new ExitError(1),
    );

    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "gateway verification", exitCode: 1 }),
      ]),
    });
    const diagnostics = getErrorOutput();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(diagnostics).toContain("Gateway probe failed: timeout");
    expect(diagnostics).toContain("Port 18789 is already in use.");
    expect(diagnostics).not.toContain("Gateway version mismatch");
  });

  it("skips the post-refresh restart when LaunchAgent already serves the expected package version", async () => {
    const { updatedRoot, updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    serviceLoaded.mockResolvedValue(true);
    mockGatewayHealth("2026.4.24", "updated-gateway");

    await updateCommand({ yes: true });

    const installCall = gatewayCommandCall(updatedEntrypoint, "install");
    expect(installCall?.[0][0]).toContain("node");
    expect(installCall?.[0].slice(1)).toEqual([
      updatedEntrypoint,
      "gateway",
      "install",
      "--force",
      "--port",
      "18789",
      "--json",
      "--update-executor",
      "run",
    ]);
    expect(installCall?.[1].cwd).toBe(updatedRoot);
    expect(installCall?.[1].timeoutMs).toBe(30 * 60_000);
    expect(gatewayCommandCall(updatedEntrypoint, "restart")).toBeUndefined();
    expect(gatewayHealthCall()).toMatchObject({ method: "health", scopes: ["operator.read"] });
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });
});
