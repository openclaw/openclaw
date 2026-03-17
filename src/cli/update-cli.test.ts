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
const pathExists = vi.fn();
const syncPluginsForUpdateChannel = vi.fn();
const updateNpmInstalledPlugins = vi.fn();

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

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    pathExists: (...args: unknown[]) => pathExists(...args),
  };
});

vi.mock("../plugins/update.js", () => ({
  syncPluginsForUpdateChannel: (...args: unknown[]) => syncPluginsForUpdateChannel(...args),
  updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPlugins(...args),
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
const { updateCommand, updateStatusCommand, updateWizardCommand } = await import("./update-cli.js");

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

  const expectPackageInstallSpec = (spec: string) => {
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["npm", "i", "-g", spec, "--no-fund", "--no-audit", "--loglevel=error"],
      expect.any(Object),
    );
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

  const setupUpdatedRootRefresh = (params?: {
    gatewayUpdateImpl?: () => Promise<UpdateRunResult>;
  }) => {
    const root = createCaseDir("openclaw-updated-root");
    const entryPath = path.join(root, "dist", "entry.js");
    pathExists.mockImplementation(async (candidate: string) => candidate === entryPath);
    if (params?.gatewayUpdateImpl) {
      vi.mocked(runGatewayUpdate).mockImplementation(params.gatewayUpdateImpl);
    } else {
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "npm",
        root,
        steps: [],
        durationMs: 100,
      });
    }
    serviceLoaded.mockResolvedValue(true);
    return { root, entryPath };
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
    pathExists.mockResolvedValue(false);
    syncPluginsForUpdateChannel.mockResolvedValue({
      changed: false,
      config: baseConfig,
      summary: {
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: baseConfig,
      outcomes: [],
    });
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);
    vi.mocked(doctorCommand).mockResolvedValue(undefined);
    confirm.mockResolvedValue(false);
    select.mockResolvedValue("stable");
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    setTty(false);
    setStdoutTty(false);
  });

  it("updateCommand dry-run previews without mutating and bypasses downgrade confirmation", async () => {
    const cases = [
      {
        name: "preview mode",
        run: async () => {
          vi.mocked(defaultRuntime.log).mockClear();
          serviceLoaded.mockResolvedValue(true);
          await updateCommand({ dryRun: true, channel: "beta" });
        },
        assert: () => {
          expect(writeConfigFile).not.toHaveBeenCalled();
          expect(runGatewayUpdate).not.toHaveBeenCalled();
          expect(runDaemonInstall).not.toHaveBeenCalled();
          expect(runRestartScript).not.toHaveBeenCalled();
          expect(runDaemonRestart).not.toHaveBeenCalled();

          const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
          expect(logs.join("\n")).toContain("Update dry-run");
          expect(logs.join("\n")).toContain("No changes were applied.");
        },
      },
      {
        name: "downgrade bypass",
        run: async () => {
          await setupNonInteractiveDowngrade();
          vi.mocked(defaultRuntime.exit).mockClear();
          await updateCommand({ dryRun: true });
        },
        assert: () => {
          expect(vi.mocked(defaultRuntime.exit).mock.calls.some((call) => call[0] === 1)).toBe(
            false,
          );
          expect(runGatewayUpdate).not.toHaveBeenCalled();
        },
      },
    ] as const;

    for (const testCase of cases) {
      vi.clearAllMocks();
      await testCase.run();
      testCase.assert();
    }
  });

  it("updateStatusCommand renders table and json output", async () => {
    const cases = [
      {
        name: "table output",
        options: { json: false },
        assert: () => {
          const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => call[0]);
          expect(logs.join("\n")).toContain("OpenClaw update status");
        },
      },
      {
        name: "json output",
        options: { json: true },
        assert: () => {
          const last = vi.mocked(defaultRuntime.log).mock.calls.at(-1)?.[0];
          expect(typeof last).toBe("string");
          const parsed = JSON.parse(String(last));
          expect(parsed.channel.value).toBe("stable");
        },
      },
    ] as const;

    for (const testCase of cases) {
      vi.mocked(defaultRuntime.log).mockClear();
      await updateStatusCommand(testCase.options);
      testCase.assert();
    }
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
      options: { yes: true },
      prepare: async () => {
        const tempDir = createCaseDir("openclaw-update");
        mockPackageInstallStatus(tempDir);
      },
      expectedChannel: undefined as "stable" | undefined,
      expectedTag: undefined as string | undefined,
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
    if (mode) {
      vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult({ mode }));
    }

    await updateCommand(options);

    if (expectedChannel !== undefined) {
      const call = expectUpdateCallChannel(expectedChannel);
      if (expectedTag !== undefined) {
        expect(call?.tag).toBe(expectedTag);
      }
      return;
    }

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["npm", "i", "-g", "openclaw@latest", "--no-fund", "--no-audit", "--loglevel=error"],
      expect.any(Object),
    );
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
    await updateCommand({});

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["npm", "i", "-g", "openclaw@latest", "--no-fund", "--no-audit", "--loglevel=error"],
      expect.any(Object),
    );
  });

  it("resolves package install specs from tags and env overrides", async () => {
    for (const scenario of [
      {
        name: "explicit dist-tag",
        run: async () => {
          mockPackageInstallStatus(createCaseDir("openclaw-update"));
          await updateCommand({ tag: "next" });
        },
        expectedSpec: "openclaw@next",
      },
      {
        name: "main shorthand",
        run: async () => {
          mockPackageInstallStatus(createCaseDir("openclaw-update"));
          await updateCommand({ yes: true, tag: "main" });
        },
        expectedSpec: "github:openclaw/openclaw#main",
      },
      {
        name: "explicit git package spec",
        run: async () => {
          mockPackageInstallStatus(createCaseDir("openclaw-update"));
          await updateCommand({ yes: true, tag: "github:openclaw/openclaw#main" });
        },
        expectedSpec: "github:openclaw/openclaw#main",
      },
      {
        name: "OPENCLAW_UPDATE_PACKAGE_SPEC override",
        run: async () => {
          mockPackageInstallStatus(createCaseDir("openclaw-update"));
          await withEnvAsync(
            { OPENCLAW_UPDATE_PACKAGE_SPEC: "http://10.211.55.2:8138/openclaw-next.tgz" },
            async () => {
              await updateCommand({ yes: true, tag: "latest" });
            },
          );
        },
        expectedSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
      },
    ]) {
      vi.clearAllMocks();
      readPackageName.mockResolvedValue("openclaw");
      readPackageVersion.mockResolvedValue("1.0.0");
      resolveGlobalManager.mockResolvedValue("npm");
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
      await scenario.run();
      expectPackageInstallSpec(scenario.expectedSpec);
    }
  });

  it("prepends portable Git PATH for package updates on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = createCaseDir("openclaw-update");
    const localAppData = createCaseDir("openclaw-localappdata");
    const portableGitMingw = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "mingw64",
      "bin",
    );
    const portableGitUsr = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "usr",
      "bin",
    );
    await fs.mkdir(portableGitMingw, { recursive: true });
    await fs.mkdir(portableGitUsr, { recursive: true });
    mockPackageInstallStatus(tempDir);
    pathExists.mockImplementation(
      async (candidate: string) => candidate === portableGitMingw || candidate === portableGitUsr,
    );

    await withEnvAsync({ LOCALAPPDATA: localAppData }, async () => {
      await updateCommand({ yes: true });
    });

    platformSpy.mockRestore();

    const updateCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    const updateOptions =
      typeof updateCall?.[1] === "object" && updateCall[1] !== null ? updateCall[1] : undefined;
    const mergedPath = updateOptions?.env?.Path ?? updateOptions?.env?.PATH ?? "";
    expect(mergedPath.split(path.delimiter).slice(0, 2)).toEqual([
      portableGitMingw,
      portableGitUsr,
    ]);
    expect(updateOptions?.env?.NPM_CONFIG_SCRIPT_SHELL).toBe("cmd.exe");
    expect(updateOptions?.env?.NODE_LLAMA_CPP_SKIP_DOWNLOAD).toBe("1");
  });

  it("updateCommand reports success and failure outcomes", async () => {
    const cases = [
      {
        name: "outputs JSON when --json is set",
        run: async () => {
          vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
          vi.mocked(defaultRuntime.log).mockClear();
          await updateCommand({ json: true });
        },
        assert: () => {
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
        },
      },
      {
        name: "exits with error on failure",
        run: async () => {
          vi.mocked(runGatewayUpdate).mockResolvedValue({
            status: "error",
            mode: "git",
            reason: "rebase-failed",
            steps: [],
            durationMs: 100,
          } satisfies UpdateRunResult);
          vi.mocked(defaultRuntime.exit).mockClear();
          await updateCommand({});
        },
        assert: () => {
          expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
        },
      },
    ] as const;

    for (const testCase of cases) {
      vi.clearAllMocks();
      await testCase.run();
      testCase.assert();
    }
  });

  it("updateCommand handles service env refresh and restart behavior", async () => {
    const cases = [
      {
        name: "refreshes service env when already installed",
        run: async () => {
          vi.mocked(runGatewayUpdate).mockResolvedValue({
            status: "ok",
            mode: "git",
            steps: [],
            durationMs: 100,
          } satisfies UpdateRunResult);
          vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
          serviceLoaded.mockResolvedValue(true);

          await updateCommand({});
        },
        assert: () => {
          expect(runDaemonInstall).toHaveBeenCalledWith({
            force: true,
            json: undefined,
          });
          expect(runRestartScript).toHaveBeenCalled();
          expect(runDaemonRestart).not.toHaveBeenCalled();
        },
      },
      {
        name: "falls back to daemon restart when service env refresh cannot complete",
        run: async () => {
          vi.mocked(runDaemonRestart).mockResolvedValue(true);
          await runRestartFallbackScenario({ daemonInstall: "fail" });
        },
        assert: () => {
          expect(runDaemonInstall).toHaveBeenCalledWith({
            force: true,
            json: undefined,
          });
          expect(runDaemonRestart).toHaveBeenCalled();
        },
      },
      {
        name: "keeps going when daemon install succeeds but restart fallback still handles relaunch",
        run: async () => {
          vi.mocked(runDaemonRestart).mockResolvedValue(true);
          await runRestartFallbackScenario({ daemonInstall: "ok" });
        },
        assert: () => {
          expect(runDaemonInstall).toHaveBeenCalledWith({
            force: true,
            json: undefined,
          });
          expect(runDaemonRestart).toHaveBeenCalled();
        },
      },
      {
        name: "skips service env refresh when --no-restart is set",
        run: async () => {
          vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
          serviceLoaded.mockResolvedValue(true);

          await updateCommand({ restart: false });
        },
        assert: () => {
          expect(runDaemonInstall).not.toHaveBeenCalled();
          expect(runRestartScript).not.toHaveBeenCalled();
          expect(runDaemonRestart).not.toHaveBeenCalled();
        },
      },
    ] as const;

    for (const testCase of cases) {
      vi.clearAllMocks();
      await testCase.run();
      testCase.assert();
    }
  });

  it.each([
    {
      name: "updateCommand refreshes service env from updated install root when available",
      invoke: async () => {
        await updateCommand({});
      },
      expectedOptions: (root: string) => expect.objectContaining({ cwd: root, timeoutMs: 60_000 }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
        expect(runRestartScript).toHaveBeenCalled();
      },
    },
    {
      name: "updateCommand preserves invocation-relative service env overrides during refresh",
      invoke: async () => {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: "./state",
            OPENCLAW_CONFIG_PATH: "./config/openclaw.json",
          },
          async () => {
            await updateCommand({});
          },
        );
      },
      expectedOptions: (root: string) =>
        expect.objectContaining({
          cwd: root,
          env: expect.objectContaining({
            OPENCLAW_STATE_DIR: path.resolve("./state"),
            OPENCLAW_CONFIG_PATH: path.resolve("./config/openclaw.json"),
          }),
          timeoutMs: 60_000,
        }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
    },
    {
      name: "updateCommand reuses the captured invocation cwd when process.cwd later fails",
      invoke: async () => {
        const originalCwd = process.cwd();
        let restoreCwd: (() => void) | undefined;
        const { root } = setupUpdatedRootRefresh({
          gatewayUpdateImpl: async () => {
            const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
              throw new Error("ENOENT: current working directory is gone");
            });
            restoreCwd = () => cwdSpy.mockRestore();
            return {
              status: "ok",
              mode: "npm",
              root,
              steps: [],
              durationMs: 100,
            };
          },
        });
        try {
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: "./state",
            },
            async () => {
              await updateCommand({});
            },
          );
        } finally {
          restoreCwd?.();
        }
        return { originalCwd };
      },
      customSetup: true,
      expectedOptions: (_root: string, context?: { originalCwd: string }) =>
        expect.objectContaining({
          cwd: expect.any(String),
          env: expect.objectContaining({
            OPENCLAW_STATE_DIR: path.resolve(context?.originalCwd ?? process.cwd(), "./state"),
          }),
          timeoutMs: 60_000,
        }),
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
    },
  ])("$name", async (testCase) => {
    const setup = testCase.customSetup ? undefined : setupUpdatedRootRefresh();
    const context = await testCase.invoke();
    const root = setup?.root ?? runCommandWithTimeout.mock.calls[0]?.[1]?.cwd;
    const entryPath = setup?.entryPath ?? path.join(String(root), "dist", "entry.js");

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [expect.stringMatching(/node/), entryPath, "gateway", "install", "--force"],
      testCase.expectedOptions(String(root), context),
    );
    testCase.assertExtra();
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
      shouldRunPackageUpdate: false,
    },
    {
      name: "allows downgrade with --yes",
      options: { yes: true },
      shouldExit: false,
      shouldRunPackageUpdate: true,
    },
  ])("$name in non-interactive mode", async ({ options, shouldExit, shouldRunPackageUpdate }) => {
    await setupNonInteractiveDowngrade();
    await updateCommand(options);

    const downgradeMessageSeen = vi
      .mocked(defaultRuntime.error)
      .mock.calls.some((call) => String(call[0]).includes("Downgrade confirmation required."));
    expect(downgradeMessageSeen).toBe(shouldExit);
    expect(vi.mocked(defaultRuntime.exit).mock.calls.some((call) => call[0] === 1)).toBe(
      shouldExit,
    );
    expect(vi.mocked(runGatewayUpdate).mock.calls.length > 0).toBe(false);
    expect(
      vi
        .mocked(runCommandWithTimeout)
        .mock.calls.some((call) => Array.isArray(call[0]) && call[0][0] === "npm"),
    ).toBe(shouldRunPackageUpdate);
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
