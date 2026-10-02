import "../test-utils/prepare-compiled-subprocesses.js";
// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import {
  installRunMainTestHooks,
  cliArgs,
  runCli,
  tryRouteCliMock,
  isCurrentRuntimeSupportedMock,
  closeActiveMemorySearchManagersMock,
  outputRootHelpMock,
  outputPrecomputedRootHelpTextMock,
  outputPrecomputedNodesHelpTextMock,
  outputPrecomputedSubcommandHelpTextMock,
  loadRootHelpRenderOptionsForConfigSensitivePluginsMock,
  tryOutputSetupOnboardConfigureHelpMock,
  buildProgramMock,
  getProgramContextMock,
  registerCoreCliByNameMock,
  registerSubCliByNameMock,
  registerPluginCliCommandsFromValidatedConfigMock,
  resolvePluginCliRootOwnerIdsMock,
  createPluginCliLoadSessionMock,
  loadPluginCliDescriptorsMock,
  resolveManifestCommandAliasOwnerMock,
  resolveManifestToolOwnerMock,
  hasEnvHttpProxyAgentConfiguredMock,
  ensureGlobalUndiciEnvProxyDispatcherMock,
  runTuiCliActionMock,
  commanderParseAsyncMock,
  progressDoneMock,
  createCliProgressMock,
  loadConfigMock,
  readSourceConfigBestEffortMock,
  startProxyMock,
  stopProxyMock,
  maybeRunCliInContainerMock,
  makeProgram,
} from "./run-main.test-support.js";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginCache, type PluginCache } from "../plugins/plugin-cache.js";
import { withEnvAsync } from "../test-utils/env.js";
import { ExpectedCliError } from "./failure-output.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";
import { registerRunMainTimelineTests } from "./run-main.timeline.test-support.js";

describe("runCli exit behavior", () => {
  installRunMainTestHooks();

  it("carries one lightweight generation through builtin reads, nested registration and actions", async () => {
    const outside = getPluginCache();
    const phases: PluginCache[] = [];
    loadConfigMock.mockImplementationOnce(() => {
      phases.push(getPluginCache());
      return {};
    });
    registerSubCliByNameMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      phases.push(getPluginCache());
    });
    const parseAsync = vi.fn(async () => {
      await Promise.resolve();
      phases.push(getPluginCache());
    });
    const program = makeProgram("plugins", parseAsync);
    buildProgramMock.mockReturnValueOnce(program).mockReturnValueOnce(program);
    tryRouteCliMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runCli(cliArgs("plugins", "late"));

    expect(phases).toHaveLength(3);
    const owner = phases[0]!;
    expect(owner.kind).toBe("operation");
    expect(phases.every((cache) => cache === owner)).toBe(true);
    expect(owner).not.toBe(outside);
    expect(getPluginCache()).toBe(outside);
    expect(createPluginCliLoadSessionMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();

    await runCli(cliArgs("plugins", "late"));
    expect(phases.at(-1)).not.toBe(owner);
    expect(getPluginCache()).toBe(outside);
  });

  it("renders nodes help from startup metadata without building the full program", async () => {
    outputPrecomputedNodesHelpTextMock.mockReturnValueOnce(true);

    await runCli(cliArgs("nodes", "--help"));

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(outputPrecomputedNodesHelpTextMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock).not.toHaveBeenCalled();
  });

  it("defers nodes help startup metadata when plugin config can change command metadata", async () => {
    const argv = cliArgs("nodes", "--help");
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    const program = makeProgram("nodes", parseAsync);
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValueOnce({ env: {} });
    outputPrecomputedNodesHelpTextMock.mockReturnValueOnce(true);
    buildProgramMock.mockReturnValueOnce(program);

    await runCli(argv);

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedNodesHelpTextMock).not.toHaveBeenCalled();
    expect(registerSubCliByNameMock.mock.calls).toEqual([[program, "nodes", argv]]);
    expect(parseAsync).toHaveBeenCalledWith(argv);
  });

  it("renders selected subcommand help from startup metadata without building the full program", async () => {
    outputPrecomputedSubcommandHelpTextMock.mockReturnValueOnce(true);

    await runCli(cliArgs("doctor", "--help"));

    expect(outputPrecomputedSubcommandHelpTextMock).toHaveBeenCalledWith("doctor");
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
  });

  it("keeps root help on the precomputed path without proxy bootstrap", async () => {
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    await runCli(cliArgs("--help"));

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(hasEnvHttpProxyAgentConfiguredMock).not.toHaveBeenCalled();
    expect(ensureGlobalUndiciEnvProxyDispatcherMock).not.toHaveBeenCalled();
  });

  it("renders setup/onboard/configure help without building the full program", async () => {
    await runCli(cliArgs("setup", "--help"));

    expect(tryOutputSetupOnboardConfigureHelpMock).toHaveBeenCalledWith(cliArgs("setup", "--help"));
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("renders root help without building the full program", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(cliArgs("--help"));

    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(cliArgs("--help"));
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledTimes(1);
    expect(outputRootHelpMock).toHaveBeenCalledTimes(1);
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(closeActiveMemorySearchManagersMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("renders config-sensitive root help live instead of precomputed metadata", async () => {
    const liveOptions: RootHelpRenderOptions = {
      config: {
        plugins: {
          slots: { memory: "memory-lancedb" },
        },
      },
      env: process.env,
    };
    loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValueOnce(liveOptions);
    outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);

    await runCli(cliArgs("--help"));

    expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
    expect(outputPrecomputedRootHelpTextMock).not.toHaveBeenCalled();
    expect(outputRootHelpMock).toHaveBeenCalledWith(liveOptions);
    expect(buildProgramMock).not.toHaveBeenCalled();
  });

  it("awaits runtime support before choosing source-only proxy config", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    isCurrentRuntimeSupportedMock.mockResolvedValueOnce(false);
    readSourceConfigBestEffortMock.mockResolvedValueOnce({
      proxy: { proxyUrl: "http://source.invalid" },
    });
    await runCli(cliArgs("plugins", "marketplace", "list"));
    expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(startProxyMock).toHaveBeenCalledWith({ proxyUrl: "http://source.invalid" });
  });

  registerRunMainTimelineTests({
    runCli: (argv) => runCli(argv),
    loadConfigMock,
    readSourceConfigBestEffortMock,
    tryRouteCliMock,
  });

  it.each([["root shorthand", cliArgs("--update", "--dry-run", "--json")]])(
    "reads source-only proxy config for the update dry-run %s",
    async (_name, argv) => {
      tryRouteCliMock.mockResolvedValueOnce(true);
      readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy: { selected: "dry-run" } });

      await runCli(argv);

      expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
      expect(loadConfigMock).not.toHaveBeenCalled();
      expect(startProxyMock).toHaveBeenCalledWith({ selected: "dry-run" });
    },
  );

  it.each([["lint", ["--lint", "--json"]]])(
    "reads source-only proxy config before Doctor %s owns state access",
    async (_mode, args) => {
      tryRouteCliMock.mockResolvedValueOnce(true);
      readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy: { selected: "doctor" } });
      loadConfigMock.mockImplementation(() => {
        throw new Error("Shared state requires Doctor repair");
      });

      await runCli(cliArgs("doctor", ...args));

      expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
      expect(loadConfigMock).not.toHaveBeenCalled();
      expect(startProxyMock).toHaveBeenCalledWith({ selected: "doctor" });
    },
  );

  it.each([
    {
      name: "profiled version-pinned skill verification",
      argv: cliArgs(
        "--profile",
        "work",
        "skills",
        "verify",
        "@owner/weather",
        "--version",
        "1.2.3",
      ),
    },
  ])("starts the managed proxy for $name", async ({ argv }) => {
    await withEnvAsync(
      {
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
      },
      async () => {
        hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(true);
        tryRouteCliMock.mockResolvedValueOnce(true);

        await runCli(argv);

        expect(startProxyMock).toHaveBeenCalledWith(undefined);
        expect(ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledOnce();
      },
    );
  });

  it.each([
    ["cron parent timeout", cliArgs("cron", "--timeout", "250", "status")],
    ["cron scratch equals", cliArgs("cron", "scratch", "job", "--set=text")],
    ["gateway handoff", cliArgs("gateway", "--port", "18789", "restart-handoff", "capabilities")],
    ["node invoke", cliArgs("nodes", "invoke", "--node", "one")],
    ["device token", cliArgs("devices", "rotate", "--device", "one")],
    ["doctor lint", cliArgs("doctor", "--lint")],
    ["proxy coverage", cliArgs("proxy", "coverage")],
  ])("routes startup diagnostics for default-machine %s output", async (_name, argv) => {
    tryRouteCliMock.mockImplementationOnce(async () => {
      expect(loggingState.forceConsoleToStderr).toBe(true);
      return true;
    });

    await runCli(argv);

    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("routes managed-proxy startup logs for plugin-declared machine output", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    let observedStdoutIsTTY: boolean | undefined;
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "path" ? ["oc-path"] : [],
    );
    loadPluginCliDescriptorsMock.mockResolvedValueOnce([
      {
        name: "path",
        description: "OC path",
        hasSubcommands: true,
        machineOutput: ({ stdoutIsTTY }: { stdoutIsTTY: boolean }) => {
          observedStdoutIsTTY = stdoutIsTTY;
          return !stdoutIsTTY;
        },
      },
    ]);
    startProxyMock.mockImplementationOnce(async () => {
      expect(loggingState.forceConsoleToStderr).toBe(true);
      return null;
    });

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    try {
      await runCli(cliArgs("path", "validate", "oc://AGENTS.md"));
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }

    expect(startProxyMock).toHaveBeenCalledWith(undefined);
    expect(observedStdoutIsTTY).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("leaves plugin-owned URL arguments on the plugin command path", async () => {
    const target = "https://gateway.example/dashboard/main/movies-a1166b81";
    const argv = cliArgs("googlemeet", target);
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync: commanderParseAsyncMock });

    await runCli(argv);

    expect(runTuiCliActionMock).not.toHaveBeenCalled();
    expect(buildProgramMock).toHaveBeenCalledTimes(1);
    expect(commanderParseAsyncMock).toHaveBeenCalledWith(argv);
  });

  it("suggests close known commands for unowned command roots before proxy startup", async () => {
    const error = await runCli(cliArgs("upate")).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExpectedCliError);
    expect((error as ExpectedCliError).humanOutput).toContain(
      "Did you mean this?\n  openclaw update\n",
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("sanitizes control characters in unowned command diagnostics", async () => {
    const primary = "bad\u001b[31m-red\u001b[0m\nforged\tline";

    await expect(runCli(cliArgs(primary))).rejects.toThrow(
      'OpenClaw does not know the command "bad-red\\nforged\\tline".',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("bounds long unowned command diagnostics without splitting Unicode", async () => {
    const primary = "🦞".repeat(1_000);

    let error: unknown;
    try {
      await runCli(cliArgs(primary));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const displayPrimary = `${"🦞".repeat(63)}…`;
    expect(displayPrimary.length).toBeLessThanOrEqual(128);
    expect(message).toContain(`OpenClaw does not know the command "${displayPrimary}".`);
    expect(message).not.toContain("�");
    expect(message.length).toBeLessThan(500);
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "plugins.allow exclusion",
      command: "workboard",
      config: { plugins: { allow: ["browser"] } },
      commandAlias: { pluginId: "workboard" },
      expectedText: '`plugins.allow` excludes "workboard"',
    },
    {
      label: "parent plugin allowlist guidance",
      command: "voicecall",
      config: { plugins: { allow: ["voicecall"] } },
      commandAlias: { pluginId: "voice-call" },
      expectedText: 'Add "voice-call" to `plugins.allow` instead of "voicecall"',
    },
    {
      label: "explicit plugin disablement",
      command: "browser",
      config: { plugins: { entries: { browser: { enabled: false } } } },
      commandAlias: { pluginId: "browser", enabledByDefault: true },
      expectedText: "plugins.entries.browser.enabled=false",
    },
    {
      label: "runtime slash command",
      command: "dreaming",
      config: {},
      commandAlias: { pluginId: "memory-core", kind: "runtime-slash", cliCommand: "memory" },
      expectedText: "runtime slash command (/dreaming)",
    },
    {
      label: "loaded agent tool",
      command: "lcm_recent",
      config: {},
      toolOwner: { toolName: "lcm_recent", pluginId: "lossless-claw", availability: "loaded" },
      expectedText: "is an agent tool available",
    },
    {
      label: "manifest-only agent tool",
      command: "feishu_chat",
      config: {},
      toolOwner: { toolName: "feishu_chat", pluginId: "feishu", availability: "manifest-only" },
      expectedText: "may be provided",
    },
  ])(
    "reports $label as an expected condition before proxy startup",
    async ({ command, config, commandAlias, toolOwner, expectedText }) => {
      loadConfigMock.mockReturnValue(config);
      resolveManifestCommandAliasOwnerMock.mockReturnValue(commandAlias);
      resolveManifestToolOwnerMock.mockReturnValue(toolOwner);

      const error = await runCli(cliArgs(command)).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ExpectedCliError);
      expect((error as ExpectedCliError).message).toContain(expectedText);
      expect((error as ExpectedCliError).humanOutput).toBe((error as Error).message);
      expect((error as ExpectedCliError).machineOutput).toBe((error as Error).message);
      expect((error as Error).message).not.toContain("Did you mean this?");
      expect(startProxyMock).not.toHaveBeenCalled();
      expect(tryRouteCliMock).not.toHaveBeenCalled();
      expect(buildProgramMock).not.toHaveBeenCalled();
      expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
    },
  );

  it("reports disabled-by-default plugin commands as expected after lazy registration", async () => {
    const program = { commands: [], parseAsync: vi.fn() };
    buildProgramMock.mockReturnValueOnce(program);
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockReturnValue(["workboard"]);
    resolveManifestCommandAliasOwnerMock.mockReturnValue({
      pluginId: "workboard",
      enabledByDefault: false,
    });

    const error = await runCli(cliArgs("workboard", "list")).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExpectedCliError);
    expect((error as ExpectedCliError).message).toContain(
      'the "workboard" plugin, but that bundled plugin is disabled by default',
    );
    expect((error as ExpectedCliError).humanOutput).toBe((error as Error).message);
    expect((error as ExpectedCliError).machineOutput).toBe((error as Error).message);
    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      {
        mode: "lazy",
        primary: "workboard",
        skipPluginValidation: false,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    expect(program.parseAsync).not.toHaveBeenCalled();
  });

  it("rejects unowned command roots even when --help is appended (regression for #81077)", async () => {
    await expect(runCli(cliArgs("foo", "--help"))).rejects.toThrow(
      'OpenClaw does not know the command "foo".',
    );

    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(buildProgramMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it("preserves plugins.allow diagnostics for roots owned only by CLI metadata", async () => {
    loadConfigMock.mockReturnValueOnce({
      plugins: { allow: ["browser"] },
    });
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({
        cfg,
        primaryCommand,
      }: {
        cfg?: { plugins?: { allow?: string[] } };
        primaryCommand?: string;
      }) => (primaryCommand === "qa" && cfg?.plugins?.allow?.length === 0 ? ["qa-lab"] : []),
    );

    await expect(runCli(cliArgs("qa"))).rejects.toThrow(
      'Add "qa-lab" to `plugins.allow` instead of "qa"',
    );
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  });

  it.each([["auth", cliArgs("auth", "--help")]])(
    "keeps reserved %s command roots out of plugin command discovery",
    async (_name, argv) => {
      const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
      const program = { commands: [], parseAsync };
      buildProgramMock.mockReturnValueOnce(program);

      await runCli(argv);

      expect(startProxyMock).not.toHaveBeenCalled();
      expect(registerSubCliByNameMock.mock.calls).toEqual([[program, argv[2], argv]]);
      expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
      expect(parseAsync).toHaveBeenCalledWith(argv);
    },
  );

  it("routes incidental logs to stderr throughout --json startup and dispatch", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "memory" ? ["memory"] : [],
    );
    let stderrDuringPluginRegistration = false;
    let stderrDuringParse = true;
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async () => {
      stderrDuringPluginRegistration = loggingState.forceConsoleToStderr;
      return {};
    });
    const parseAsync = vi.fn().mockImplementationOnce(async () => {
      stderrDuringParse = loggingState.forceConsoleToStderr;
    });
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync });

    await runCli(cliArgs("memory", "search", "query", "--json"));

    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      {
        mode: "lazy",
        primary: "memory",
        skipPluginValidation: true,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    expect(stderrDuringPluginRegistration).toBe(true);
    expect(stderrDuringParse).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("retains stderr routing for late subsystem logs in one-shot JSON commands", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const previousRawConsole = loggingState.rawConsole;
    const previousOverrideSettings = loggingState.overrideSettings as Parameters<
      typeof setLoggerOverride
    >[0];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
      value: string | Uint8Array,
    ) => {
      stdout.push(String(value));
      return true;
    }) as typeof process.stdout.write);
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    loggingState.rawConsole = {
      log: (value) => stdout.push(String(value)),
      info: (value) => stdout.push(String(value)),
      warn: (value) => stderr.push(String(value)),
      error: (value) => stderr.push(String(value)),
    };
    buildProgramMock.mockReturnValueOnce({
      commands: [],
      parseAsync: vi.fn(async () => {
        process.stdout.write('{"ok":true,"status":"ok"}\n');
      }),
    });

    try {
      await runCli(cliArgs("agent", "exec", "inspect", "--json"), {
        retainConsoleRoutingUntilProcessExit: true,
      });
      createSubsystemLogger("state/db").info("late migration diagnostic");

      expect(JSON.parse(stdout.join(""))).toEqual({ ok: true, status: "ok" });
      expect(stderr).toEqual([expect.stringContaining("late migration diagnostic")]);
      expect(loggingState.forceConsoleToStderr).toBe(true);
    } finally {
      stdoutWrite.mockRestore();
      loggingState.rawConsole = previousRawConsole;
      setLoggerOverride(previousOverrideSettings);
      loggingState.forceConsoleToStderr = false;
      loggingState.earlyConsoleRoutingRestore = null;
    }
  });

  it("does not route lazy plugin registration logs for pass-through --json after terminator", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    resolvePluginCliRootOwnerIdsMock.mockImplementation(
      ({ primaryCommand }: { primaryCommand?: string }) =>
        primaryCommand === "memory" ? ["memory"] : [],
    );
    let stderrDuringPluginRegistration = true;
    registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async () => {
      stderrDuringPluginRegistration = loggingState.forceConsoleToStderr;
      return {};
    });
    const parseAsync = vi.fn().mockResolvedValueOnce(undefined);
    buildProgramMock.mockReturnValueOnce({ commands: [], parseAsync });

    await runCli(cliArgs("memory", "--", "--json"));

    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      undefined,
      {
        mode: "lazy",
        primary: "memory",
        skipPluginValidation: false,
        session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
      },
    );
    const session = createPluginCliLoadSessionMock.mock.results.at(-1)?.value;
    expect(session?.close.mock.invocationCallOrder[0]).toBeLessThan(
      parseAsync.mock.invocationCallOrder[0]!,
    );
    expect(stderrDuringPluginRegistration).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("loads the real primary command before rendering command help", async () => {
    const program = {
      commands: [{ name: () => "doctor" }],
      parseAsync: vi.fn().mockResolvedValueOnce(undefined),
    };
    buildProgramMock.mockReturnValueOnce(program);
    const ctx = { programVersion: "0.0.0-test" };
    getProgramContextMock.mockReturnValueOnce(ctx as never);

    await runCli(["node", "openclaw", "doctor", "--help"]);

    expect(registerCoreCliByNameMock.mock.calls).toEqual([[program, ctx, "doctor"]]);
    expect(registerSubCliByNameMock.mock.calls).toEqual([
      [program, "doctor", ["node", "openclaw", "doctor", "--help"]],
    ]);
  });

  it("passes config get machine ownership into route-first startup", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(["node", "openclaw", "config", "get", "gateway.port"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(
      ["node", "openclaw", "config", "get", "gateway.port"],
      { machineOutput: true },
    );
  });

  it("keeps plain config startup out of machine-output mode", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn(async () => expect(progressDoneMock).toHaveBeenCalled());
    buildProgramMock.mockReturnValueOnce(makeProgram("config", parseAsync));

    await runCli(["node", "openclaw", "config"]);

    expect(createCliProgressMock).toHaveBeenCalledWith({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
    });
    expect(parseAsync).toHaveBeenCalledWith(["node", "openclaw", "config"]);
  });

  it.each([
    ["status JSON", ["node", "openclaw", "models", "--status-json"]],
    ["status plain", ["node", "openclaw", "models", "--status-plain"]],
  ])("keeps models %s output free of proxy startup", async (_name, argv) => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    await runCli(argv);
    expect(startProxyMock).not.toHaveBeenCalled();
    expect(stopProxyMock).not.toHaveBeenCalled();
  });
  it("suppresses startup progress for plain model output before full CLI parsing", async () => {
    tryRouteCliMock.mockResolvedValueOnce(false);
    const parseAsync = vi.fn(async () => expect(progressDoneMock).toHaveBeenCalled());
    buildProgramMock.mockReturnValueOnce(makeProgram("models", parseAsync));

    await runCli(["node", "openclaw", "models", "aliases", "list", "--plain"]);

    expect(createCliProgressMock).toHaveBeenCalledWith({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      enabled: false,
    });
    expect(parseAsync).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "models",
      "aliases",
      "list",
      "--plain",
    ]);
  });
});
