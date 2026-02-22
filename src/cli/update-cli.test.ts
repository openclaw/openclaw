import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { withEnvAsync } from "../test-utils/env.js";

const confirm = vi.fn();
const select = vi.fn();
const spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
const isCancel = (value: unknown) => value === "cancel";

const readPackageName = vi.fn();
const readPackageVersion = vi.fn();
const resolveGlobalManager = vi.fn();
const serviceLoaded = vi.fn();
const prepareRestartScript = vi.fn();
const runRestartScript = vi.fn();
const mockedRunDaemonInstall = vi.fn();
const serviceReadRuntime = vi.fn();
const inspectPortUsage = vi.fn();
const classifyPortListener = vi.fn();
const formatPortDiagnostics = vi.fn();

vi.mock("@clack/prompts", () => ({
  confirm,
  select,
  isCancel,
  spinner,
}));

// Mock the update-runner module
vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
  writeConfigFile: vi.fn(),
}));

vi.mock("../infra/update-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/update-check.js")>();
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    fetchNpmTagVersion: vi.fn(),
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    })),
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("./update-cli/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./update-cli/shared.js")>();
  return {
    ...actual,
    readPackageName,
    readPackageVersion,
    resolveGlobalManager,
  };
});

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    isLoaded: (...args: unknown[]) => serviceLoaded(...args),
    readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
  })),
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
  classifyPortListener: (...args: unknown[]) => classifyPortListener(...args),
  formatPortDiagnostics: (...args: unknown[]) => formatPortDiagnostics(...args),
}));

vi.mock("./update-cli/restart-helper.js", () => ({
  prepareRestartScript: (...args: unknown[]) => prepareRestartScript(...args),
  runRestartScript: (...args: unknown[]) => runRestartScript(...args),
}));

// Mock doctor (heavy module; should not run in unit tests)
vi.mock("../commands/doctor.js", () => ({
  doctorCommand: vi.fn(),
}));
// Mock the daemon-cli module
vi.mock("./daemon-cli.js", () => ({
  runDaemonInstall: mockedRunDaemonInstall,
  runDaemonRestart: vi.fn(),
}));

// Mock the runtime
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const { runGatewayUpdate } = await import("../infra/update-runner.js");
const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
const { readConfigFileSnapshot, writeConfigFile } = await import("../config/config.js");
const { checkUpdateStatus, fetchNpmTagVersion, resolveNpmChannelTag } =
  await import("../infra/update-check.js");
const { runCommandWithTimeout } = await import("../process/exec.js");
const { runDaemonRestart, runDaemonInstall } = await import("./daemon-cli.js");
const { doctorCommand } = await import("../commands/doctor.js");
const { defaultRuntime } = await import("../runtime.js");
const { updateCommand, registerUpdateCli, updateStatusCommand, updateWizardCommand } =
  await import("./update-cli.js");

describe("update-cli", () => {
  const fixtureRoot = "/tmp/openclaw-update-tests";
  let fixtureCount = 0;

  const createCaseDir = (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    // Tests only need a stable path; the directory does not have to exist because all I/O is mocked.
    return dir;
  };

  const baseConfig = {} as OpenClawConfig;
  const baseSnapshot: ConfigFileSnapshot = {
    path: "/tmp/openclaw-config.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: baseConfig,
    valid: true,
    config: baseConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };

  const setTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  };

  const setStdoutTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
    });
  };

  const mockPackageInstallStatus = (root: string) => {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
      deps: {
        manager: "npm",
        status: "ok",
        lockfilePath: null,
        markerPath: null,
      },
    });
  };

  const expectUpdateCallChannel = (channel: string) => {
    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.channel).toBe(channel);
    return call;
  };

  const makeOkUpdateResult = (overrides: Partial<UpdateRunResult> = {}): UpdateRunResult =>
    ({
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
      ...overrides,
    }) as UpdateRunResult;

  const runRestartFallbackScenario = async (params: { daemonInstall: "ok" | "fail" }) => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    if (params.daemonInstall === "fail") {
      vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));
    } else {
      vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    }
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    expect(runDaemonRestart).toHaveBeenCalled();
  };

  const setupNonInteractiveDowngrade = async () => {
    const tempDir = createCaseDir("openclaw-update");
    setTty(false);
    readPackageVersion.mockResolvedValue("2.0.0");

    mockPackageInstallStatus(tempDir);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.0.1",
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "npm",
      steps: [],
      durationMs: 100,
    });
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    return tempDir;
  };

  beforeEach(() => {
    confirm.mockClear();
    select.mockClear();
    vi.mocked(runGatewayUpdate).mockClear();
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(readConfigFileSnapshot).mockClear();
    vi.mocked(writeConfigFile).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(fetchNpmTagVersion).mockClear();
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(runCommandWithTimeout).mockClear();
    vi.mocked(runDaemonRestart).mockClear();
    vi.mocked(mockedRunDaemonInstall).mockClear();
    vi.mocked(doctorCommand).mockClear();
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();
    readPackageName.mockClear();
    readPackageVersion.mockClear();
    resolveGlobalManager.mockClear();
    serviceLoaded.mockClear();
    serviceReadRuntime.mockClear();
    prepareRestartScript.mockClear();
    runRestartScript.mockClear();
    inspectPortUsage.mockClear();
    classifyPortListener.mockClear();
    formatPortDiagnostics.mockClear();
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/test/path",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/test/path",
        sha: "abcdef1234567890",
        tag: "v1.2.3",
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "/test/path/pnpm-lock.yaml",
        markerPath: "/test/path/node_modules",
      },
      registry: {
        latestVersion: "1.2.3",
      },
    });
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    readPackageName.mockResolvedValue("openclaw");
    readPackageVersion.mockResolvedValue("1.0.0");
    resolveGlobalManager.mockResolvedValue("npm");
    serviceLoaded.mockResolvedValue(false);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: 4242,
      state: "running",
    });
    prepareRestartScript.mockResolvedValue("/tmp/openclaw-restart-test.sh");
    runRestartScript.mockResolvedValue(undefined);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4242, command: "openclaw-gateway" }],
      hints: [],
    });
    classifyPortListener.mockReturnValue("gateway");
    formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);
    vi.mocked(doctorCommand).mockResolvedValue(undefined);
    confirm.mockResolvedValue(false);
    select.mockResolvedValue("stable");
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    setTty(false);
    setStdoutTty(false);
  });

  it("exports updateCommand and registerUpdateCli", async () => {
    expect(typeof updateCommand).toBe("function");
    expect(typeof registerUpdateCli).toBe("function");
    expect(typeof updateWizardCommand).toBe("function");
  }, 20_000);

  it("updateCommand runs update and outputs result", async () => {
    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      root: "/test/path",
      before: { sha: "abc123", version: "1.0.0" },
      after: { sha: "def456", version: "1.0.1" },
      steps: [
        {
          name: "git fetch",
          command: "git fetch",
          cwd: "/test/path",
          durationMs: 100,
          exitCode: 0,
        },
      ],
      durationMs: 500,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);

    await updateCommand({ json: false });

    expect(runGatewayUpdate).toHaveBeenCalled();
    expect(defaultRuntime.log).toHaveBeenCalled();
  });

  it("updateStatusCommand prints table output", async () => {
    await updateStatusCommand({ json: false });

    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => call[0]);
    expect(logs.join("\n")).toContain("OpenClaw update status");
  });

  it("updateStatusCommand emits JSON", async () => {
    await updateStatusCommand({ json: true });

    const last = vi.mocked(defaultRuntime.log).mock.calls.at(-1)?.[0];
    expect(typeof last).toBe("string");
    const parsed = JSON.parse(String(last));
    expect(parsed.channel.value).toBe("stable");
  });

  it.each([
    {
      name: "defaults to dev channel for git installs when unset",
      mode: "git" as const,
      options: {},
      prepare: async () => {},
      expectedChannel: "dev" as const,
      expectedTag: undefined as string | undefined,
    },
    {
      name: "defaults to stable channel for package installs when unset",
      mode: "npm" as const,
      options: { yes: true },
      prepare: async () => {
        const tempDir = createCaseDir("openclaw-update");
        mockPackageInstallStatus(tempDir);
      },
      expectedChannel: "stable" as const,
      expectedTag: "latest",
    },
    {
      name: "uses stored beta channel when configured",
      mode: "git" as const,
      options: {},
      prepare: async () => {
        vi.mocked(readConfigFileSnapshot).mockResolvedValue({
          ...baseSnapshot,
          config: { update: { channel: "beta" } } as OpenClawConfig,
        });
      },
      expectedChannel: "beta" as const,
      expectedTag: undefined as string | undefined,
    },
  ])("$name", async ({ mode, options, prepare, expectedChannel, expectedTag }) => {
    await prepare();
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult({ mode }));

    await updateCommand(options);

    const call = expectUpdateCallChannel(expectedChannel);
    if (expectedTag !== undefined) {
      expect(call?.tag).toBe(expectedTag);
    }
  });

  it("falls back to latest when beta tag is older than release", async () => {
    const tempDir = createCaseDir("openclaw-update");

    mockPackageInstallStatus(tempDir);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      config: { update: { channel: "beta" } } as OpenClawConfig,
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "1.2.3-1",
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue(
      makeOkUpdateResult({
        mode: "npm",
      }),
    );

    await updateCommand({});

    const call = expectUpdateCallChannel("beta");
    expect(call?.tag).toBe("latest");
  });

  it("honors --tag override", async () => {
    const tempDir = createCaseDir("openclaw-update");

    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(tempDir);
    vi.mocked(runGatewayUpdate).mockResolvedValue(
      makeOkUpdateResult({
        mode: "npm",
      }),
    );

    await updateCommand({ tag: "next" });

    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.tag).toBe("next");
  });

  it("updateCommand outputs JSON when --json is set", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    vi.mocked(defaultRuntime.log).mockClear();

    await updateCommand({ json: true });

    const logCalls = vi.mocked(defaultRuntime.log).mock.calls;
    const jsonOutput = logCalls.find((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
  });

  it("updateCommand exits with error on failure", async () => {
    const mockResult: UpdateRunResult = {
      status: "error",
      mode: "git",
      reason: "rebase-failed",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateCommand({});

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("updateCommand restarts daemon by default", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonRestart).toHaveBeenCalled();
  });

  it("updateCommand refreshes gateway service env when service is already installed", async () => {
    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    expect(runRestartScript).toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("updateCommand refreshes service env from updated install root when available", async () => {
    const root = createCaseDir("openclaw-updated-root");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "entry.js"), "console.log('ok');\n", "utf8");

    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "npm",
      root,
      steps: [],
      durationMs: 100,
    });
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({});

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        expect.stringMatching(/node/),
        path.join(root, "dist", "entry.js"),
        "gateway",
        "install",
        "--force",
      ],
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runRestartScript).toHaveBeenCalled();
  });

  it("updateCommand falls back to restart when env refresh install fails", async () => {
    await runRestartFallbackScenario({ daemonInstall: "fail" });
  });

  it("updateCommand falls back to restart when no detached restart script is available", async () => {
    await runRestartFallbackScenario({ daemonInstall: "ok" });
  });

  it("updateCommand does not refresh service env when --no-restart is set", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({ restart: false });

    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("updateCommand continues after doctor sub-step and clears update flag", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        vi.mocked(doctorCommand).mockResolvedValue(undefined);
        vi.mocked(defaultRuntime.log).mockClear();

        await updateCommand({});

        expect(doctorCommand).toHaveBeenCalledWith(
          defaultRuntime,
          expect.objectContaining({ nonInteractive: true }),
        );
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();

        const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(
          logLines.some((line) =>
            line.includes("Leveled up! New skills unlocked. You're welcome."),
          ),
        ).toBe(true);
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("updateCommand skips restart when --no-restart is set", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());

    await updateCommand({ restart: false });

    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("updateCommand skips success message when restart does not run", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    vi.mocked(runDaemonRestart).mockResolvedValue(false);
    vi.mocked(defaultRuntime.log).mockClear();

    await updateCommand({ restart: true });

    const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logLines.some((line) => line.includes("Daemon restarted successfully."))).toBe(false);
  });

  it.each([
    {
      name: "update command",
      run: async () => await updateCommand({ timeout: "invalid" }),
      requireTty: false,
    },
    {
      name: "update status command",
      run: async () => await updateStatusCommand({ timeout: "invalid" }),
      requireTty: false,
    },
    {
      name: "update wizard command",
      run: async () => await updateWizardCommand({ timeout: "invalid" }),
      requireTty: true,
    },
  ])("validates timeout option for $name", async ({ run, requireTty }) => {
    setTty(requireTty);
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    await run();

    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("persists update channel when --channel is set", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());

    await updateCommand({ channel: "beta" });

    expect(writeConfigFile).toHaveBeenCalled();
    const call = vi.mocked(writeConfigFile).mock.calls[0]?.[0] as {
      update?: { channel?: string };
    };
    expect(call?.update?.channel).toBe("beta");
  });

  it.each([
    {
      name: "requires confirmation without --yes",
      options: {},
      shouldExit: true,
      shouldRunUpdate: false,
    },
    {
      name: "allows downgrade with --yes",
      options: { yes: true },
      shouldExit: false,
      shouldRunUpdate: true,
    },
  ])("$name in non-interactive mode", async ({ options, shouldExit, shouldRunUpdate }) => {
    await setupNonInteractiveDowngrade();
    await updateCommand(options);

    const downgradeMessageSeen = vi
      .mocked(defaultRuntime.error)
      .mock.calls.some((call) => String(call[0]).includes("Downgrade confirmation required."));
    expect(downgradeMessageSeen).toBe(shouldExit);
    expect(vi.mocked(defaultRuntime.exit).mock.calls.some((call) => call[0] === 1)).toBe(
      shouldExit,
    );
    expect(vi.mocked(runGatewayUpdate).mock.calls.length > 0).toBe(shouldRunUpdate);
  });

  it("updateWizardCommand requires a TTY", async () => {
    setTty(false);
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateWizardCommand({});

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Update wizard requires a TTY"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("updateWizardCommand offers dev checkout and forwards selections", async () => {
    const tempDir = createCaseDir("openclaw-update-wizard");
    await withEnvAsync({ OPENCLAW_GIT_DIR: tempDir }, async () => {
      setTty(true);

      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/test/path",
        installKind: "package",
        packageManager: "npm",
        deps: {
          manager: "npm",
          status: "ok",
          lockfilePath: null,
          markerPath: null,
        },
      });
      select.mockResolvedValue("dev");
      confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "git",
        steps: [],
        durationMs: 100,
      });

      await updateWizardCommand({});

      const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
      expect(call?.channel).toBe("dev");
    });
  });
});
