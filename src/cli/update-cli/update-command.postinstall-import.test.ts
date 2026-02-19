import { describe, expect, it, vi } from "vitest";

describe("updateCommand post-install imports", () => {
  it("preloads restart/doctor modules before package update swaps dist chunks", async () => {
    vi.resetModules();

    let distChunksReplaced = false;
    const runDaemonRestart = vi.fn(async () => true);
    const doctorCommand = vi.fn(async () => {});
    const log = vi.fn();

    vi.doMock("@clack/prompts", () => ({
      confirm: vi.fn(),
      isCancel: vi.fn(() => false),
    }));

    vi.doMock("../../commands/doctor-completion.js", () => ({
      checkShellCompletionStatus: vi.fn(async () => ({
        usesSlowPattern: false,
        profileInstalled: true,
        cacheExists: true,
        shell: "bash",
      })),
      ensureCompletionCacheExists: vi.fn(async () => true),
    }));

    vi.doMock("../../commands/doctor.js", () => {
      if (distChunksReplaced) {
        throw new Error("doctor chunk was replaced during update");
      }
      return { doctorCommand };
    });

    vi.doMock("../../config/config.js", () => ({
      readConfigFileSnapshot: vi.fn(async () => ({ valid: true, config: {}, issues: [] })),
      writeConfigFile: vi.fn(async () => {}),
    }));

    vi.doMock("../../infra/update-channels.js", () => ({
      channelToNpmTag: vi.fn(() => "latest"),
      DEFAULT_GIT_CHANNEL: "dev",
      DEFAULT_PACKAGE_CHANNEL: "stable",
      normalizeUpdateChannel: vi.fn((value?: string | null) => {
        if (!value) {
          return null;
        }
        const lower = value.toLowerCase();
        if (lower === "stable" || lower === "beta" || lower === "dev") {
          return lower;
        }
        return null;
      }),
    }));

    vi.doMock("../../infra/update-check.js", () => ({
      compareSemverStrings: vi.fn(() => -1),
      resolveNpmChannelTag: vi.fn(async () => ({ tag: "latest", version: "9.9.9" })),
      checkUpdateStatus: vi.fn(async () => ({
        root: "/tmp/openclaw",
        installKind: "package",
        packageManager: "npm",
      })),
    }));

    vi.doMock("../../infra/update-global.js", () => ({
      cleanupGlobalRenameDirs: vi.fn(async () => {}),
      globalInstallArgs: vi.fn(() => ["npm", "i", "-g", "openclaw@latest"]),
      resolveGlobalPackageRoot: vi.fn(async () => null),
    }));

    vi.doMock("../../infra/update-runner.js", () => ({
      runGatewayUpdate: vi.fn(async () => {
        distChunksReplaced = true;
        return {
          status: "ok",
          mode: "npm",
          root: "/tmp/openclaw",
          before: { version: "1.0.0" },
          after: { version: "9.9.9" },
          steps: [],
          durationMs: 10,
        };
      }),
    }));

    vi.doMock("../../plugins/update.js", () => ({
      syncPluginsForUpdateChannel: vi.fn(async (params: { config: object }) => ({
        changed: false,
        config: params.config,
        summary: {
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
      })),
      updateNpmInstalledPlugins: vi.fn(async (params: { config: object }) => ({
        changed: false,
        config: params.config,
        outcomes: [],
      })),
    }));

    vi.doMock("../../process/exec.js", () => ({
      runCommandWithTimeout: vi.fn(async () => ({
        stdout: "",
        stderr: "",
        code: 0,
      })),
    }));

    vi.doMock("../../runtime.js", () => ({
      defaultRuntime: {
        log,
        error: vi.fn(),
        exit: vi.fn(),
      },
    }));

    vi.doMock("../../terminal/prompt-style.js", () => ({
      stylePromptMessage: vi.fn((message: string) => message),
    }));

    vi.doMock("../../terminal/theme.js", () => ({
      theme: {
        muted: (value: string) => value,
        warn: (value: string) => value,
        error: (value: string) => value,
        heading: (value: string) => value,
        success: (value: string) => value,
      },
    }));

    vi.doMock("../../utils.js", () => ({
      pathExists: vi.fn(async () => false),
    }));

    vi.doMock("../cli-name.js", () => ({
      resolveCliName: vi.fn(() => "openclaw"),
      replaceCliName: vi.fn((cmd: string) => cmd),
    }));

    vi.doMock("../command-format.js", () => ({
      formatCliCommand: vi.fn((cmd: string) => cmd),
    }));

    vi.doMock("../completion-cli.js", () => ({
      installCompletion: vi.fn(async () => {}),
    }));

    vi.doMock("../daemon-cli.js", () => {
      if (distChunksReplaced) {
        throw new Error("daemon chunk was replaced during update");
      }
      return { runDaemonRestart };
    });

    vi.doMock("./progress.js", () => ({
      createUpdateProgress: vi.fn(() => ({ progress: {}, stop: vi.fn() })),
      printResult: vi.fn(),
    }));

    vi.doMock("./shared.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./shared.js")>();
      return {
        ...actual,
        resolveUpdateRoot: vi.fn(async () => "/tmp/openclaw"),
        readPackageVersion: vi.fn(async () => "1.0.0"),
        resolveTargetVersion: vi.fn(async () => "9.9.9"),
        tryWriteCompletionCache: vi.fn(async () => {}),
      };
    });

    vi.doMock("./suppress-deprecations.js", () => ({
      suppressDeprecations: vi.fn(),
    }));

    const { updateCommand } = await import("./update-command.js");

    await updateCommand({});

    expect(distChunksReplaced).toBe(true);
    expect(runDaemonRestart).toHaveBeenCalledTimes(1);
    expect(doctorCommand).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((call) => String(call[0]).includes("Daemon restart failed"))).toBe(
      false,
    );
  });
});
