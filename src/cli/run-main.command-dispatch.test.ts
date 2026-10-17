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
import { expect, it, vi, type MockInstance } from "vitest";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginCache, type PluginCache } from "../plugins/plugin-cache.js";
import { withEnvAsync } from "../test-utils/env.js";
import { ExpectedCliError } from "./failure-output.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";
import { registerRunMainTimelineTests } from "./run-main.timeline.test-support.js";

function expectNoCalls(...mocks: MockInstance[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}
function expectNoDispatch() {
  expectNoCalls(
    startProxyMock,
    tryRouteCliMock,
    buildProgramMock,
    registerPluginCliCommandsFromValidatedConfigMock,
  );
}
function expectLazyRegistration(
  primary: string,
  skipPluginValidation: boolean,
  program: unknown = expect.anything(),
) {
  expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledWith(
    program,
    undefined,
    undefined,
    {
      mode: "lazy",
      primary,
      skipPluginValidation,
      session: createPluginCliLoadSessionMock.mock.results.at(-1)?.value,
    },
  );
}
function expectPolicyError(error: unknown, text: string) {
  expect(error).toBeInstanceOf(ExpectedCliError);
  if (!(error instanceof ExpectedCliError)) {
    throw new Error("Expected a CLI policy error");
  }
  expect(error).toMatchObject({
    message: expect.stringContaining(text),
    humanOutput: error.message,
    machineOutput: error.message,
  });
}
function ownPluginRoot(primary: string) {
  resolvePluginCliRootOwnerIdsMock.mockImplementation(
    ({ primaryCommand }: { primaryCommand?: string }) =>
      primaryCommand === primary ? [primary] : [],
  );
}
function prepareProgram(primary?: string, parseAsync = vi.fn().mockResolvedValue(undefined)) {
  const program = primary ? makeProgram(primary, parseAsync) : { commands: [], parseAsync };
  buildProgramMock.mockReturnValueOnce(program);
  return { program, parseAsync };
}

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
  const { program } = prepareProgram("plugins", parseAsync);
  buildProgramMock.mockReturnValueOnce(program);
  tryRouteCliMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

  await runCli(cliArgs("plugins", "late"));

  expect(phases).toHaveLength(3);
  const owner = phases[0]!;
  expect(owner.kind).toBe("operation");
  expect(phases.every((cache) => cache === owner)).toBe(true);
  expect(owner).not.toBe(outside);
  expect(getPluginCache()).toBe(outside);
  expectNoCalls(createPluginCliLoadSessionMock, registerPluginCliCommandsFromValidatedConfigMock);

  await runCli(cliArgs("plugins", "late"));
  expect(phases.at(-1)).not.toBe(owner);
  expect(getPluginCache()).toBe(outside);
});

it.each(["nodes", "setup"])(
  "renders %s help without building the full program",
  async (command) => {
    if (command === "nodes") {
      outputPrecomputedNodesHelpTextMock.mockReturnValueOnce(true);
    }
    const argv = cliArgs(command, "--help");
    await runCli(argv);
    expectNoCalls(tryRouteCliMock, buildProgramMock);
    if (command === "nodes") {
      expect(outputPrecomputedNodesHelpTextMock).toHaveBeenCalledOnce();
      expectNoCalls(registerSubCliByNameMock);
    } else {
      expect(tryOutputSetupOnboardConfigureHelpMock).toHaveBeenCalledWith(argv);
      expectNoCalls(registerPluginCliCommandsFromValidatedConfigMock);
    }
  },
);

it("defers nodes help startup metadata when plugin config can change command metadata", async () => {
  const argv = cliArgs("nodes", "--help");
  const { program, parseAsync } = prepareProgram("nodes");
  loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValueOnce({ env: {} });
  outputPrecomputedNodesHelpTextMock.mockReturnValueOnce(true);

  await runCli(argv);

  expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledTimes(1);
  expect(outputPrecomputedNodesHelpTextMock).not.toHaveBeenCalled();
  expect(registerSubCliByNameMock.mock.calls).toEqual([[program, "nodes", argv]]);
  expect(parseAsync).toHaveBeenCalledWith(argv);
});

it.each(["precomputed", "fallback", "config-sensitive"])(
  "renders %s root help without bootstrapping",
  async (mode) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);
    const liveOptions: RootHelpRenderOptions = {
      config: { plugins: { slots: { memory: "memory-lancedb" } } },
      env: process.env,
    };
    if (mode === "config-sensitive") {
      loadRootHelpRenderOptionsForConfigSensitivePluginsMock.mockResolvedValueOnce(liveOptions);
    }
    if (mode !== "fallback") {
      outputPrecomputedRootHelpTextMock.mockReturnValueOnce(true);
    }
    try {
      await runCli(cliArgs("--help"));
      expect(loadRootHelpRenderOptionsForConfigSensitivePluginsMock).toHaveBeenCalledOnce();
      expect(buildProgramMock).not.toHaveBeenCalled();
      if (mode === "config-sensitive") {
        expect(outputPrecomputedRootHelpTextMock).not.toHaveBeenCalled();
        expect(outputRootHelpMock).toHaveBeenCalledWith(liveOptions);
      } else {
        expect(outputPrecomputedRootHelpTextMock).toHaveBeenCalledOnce();
        if (mode === "precomputed") {
          expectNoCalls(
            hasEnvHttpProxyAgentConfiguredMock,
            ensureGlobalUndiciEnvProxyDispatcherMock,
          );
        } else {
          expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(cliArgs("--help"));
          expect(outputRootHelpMock).toHaveBeenCalledOnce();
          expectNoCalls(tryRouteCliMock, closeActiveMemorySearchManagersMock, exitSpy);
        }
      }
    } finally {
      exitSpy.mockRestore();
    }
  },
);

it.each([
  [
    "unsupported runtime",
    cliArgs("plugins", "marketplace", "list"),
    { proxyUrl: "http://source.invalid" },
  ],
  ["Doctor lint", cliArgs("doctor", "--lint", "--json"), { selected: "doctor" }],
] as const)("reads source-only proxy config for %s", async (mode, argv, proxy) => {
  tryRouteCliMock.mockResolvedValueOnce(true);
  if (mode === "unsupported runtime") {
    isCurrentRuntimeSupportedMock.mockResolvedValueOnce(false);
  }
  readSourceConfigBestEffortMock.mockResolvedValueOnce({ proxy });
  loadConfigMock.mockImplementation(() => {
    throw new Error("Shared state must not be accessed");
  });
  await runCli(argv);
  expect(readSourceConfigBestEffortMock).toHaveBeenCalledOnce();
  expectNoCalls(loadConfigMock);
  expect(startProxyMock).toHaveBeenCalledWith(proxy);
});

registerRunMainTimelineTests({
  runCli: (argv) => runCli(argv),
  loadConfigMock,
  readSourceConfigBestEffortMock,
  tryRouteCliMock,
});

it("starts the managed proxy for profiled version-pinned skill verification", async () => {
  await withEnvAsync(
    {
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
    },
    async () => {
      hasEnvHttpProxyAgentConfiguredMock.mockReturnValue(true);
      tryRouteCliMock.mockResolvedValueOnce(true);

      await runCli(
        cliArgs("--profile", "work", "skills", "verify", "@owner/weather", "--version", "1.2.3"),
      );

      expect(startProxyMock).toHaveBeenCalledWith(undefined);
      expect(ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledOnce();
    },
  );
});

it.each([
  ["cron scratch equals", cliArgs("cron", "scratch", "job", "--set=text")],
  ["gateway handoff", cliArgs("gateway", "--port", "18789", "restart-handoff", "capabilities")],
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
  prepareProgram(undefined, commanderParseAsyncMock);

  await runCli(argv);

  expect(runTuiCliActionMock).not.toHaveBeenCalled();
  expect(buildProgramMock).toHaveBeenCalledTimes(1);
  expect(commanderParseAsyncMock).toHaveBeenCalledWith(argv);
});

it.each([
  [cliArgs("upate"), "Did you mean this?\n  openclaw update\n"],
  [
    cliArgs("bad\u001b[31m-red\u001b[0m\nforged\tline"),
    'OpenClaw does not know the command "bad-red\\nforged\\tline".',
  ],
  // #81077: --help must not bypass unknown-root rejection.
  [cliArgs("foo", "--help"), 'OpenClaw does not know the command "foo".'],
] as const)("rejects unowned command roots %j before dispatch", async (argv, message) => {
  const error = await runCli(argv).catch((cause: unknown) => cause);
  expectPolicyError(error, message);
  expectNoDispatch();
});

it("bounds long unowned command diagnostics without splitting Unicode", async () => {
  const primary = "🦞".repeat(1_000);

  const error = await runCli(cliArgs(primary)).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  const displayPrimary = `${"🦞".repeat(63)}…`;
  expect(displayPrimary.length).toBeLessThanOrEqual(128);
  expect(message).toContain(`OpenClaw does not know the command "${displayPrimary}".`);
  expect(message).not.toContain("�");
  expect(message.length).toBeLessThan(500);
  expectNoDispatch();
});

it.each([
  {
    command: "workboard",
    config: { plugins: { allow: ["browser"] } },
    commandAlias: { pluginId: "workboard" },
    expectedText: '`plugins.allow` excludes "workboard"',
  },
  {
    command: "voicecall",
    config: { plugins: { allow: ["voicecall"] } },
    commandAlias: { pluginId: "voice-call" },
    expectedText: 'Add "voice-call" to `plugins.allow` instead of "voicecall"',
  },
  {
    command: "browser",
    config: { plugins: { entries: { browser: { enabled: false } } } },
    commandAlias: { pluginId: "browser", enabledByDefault: true },
    expectedText: "plugins.entries.browser.enabled=false",
  },
  {
    command: "dreaming",
    commandAlias: { pluginId: "memory-core", kind: "runtime-slash", cliCommand: "memory" },
    expectedText: "runtime slash command (/dreaming)",
  },
  {
    command: "lcm_recent",
    toolOwner: { toolName: "lcm_recent", pluginId: "lossless-claw", availability: "loaded" },
    expectedText: "is an agent tool available",
  },
  {
    command: "feishu_chat",
    toolOwner: { toolName: "feishu_chat", pluginId: "feishu", availability: "manifest-only" },
    expectedText: "may be provided",
  },
])(
  "reports $command as an expected condition before proxy startup",
  async ({ command, config = {}, commandAlias, toolOwner, expectedText }) => {
    loadConfigMock.mockReturnValue(config);
    resolveManifestCommandAliasOwnerMock.mockReturnValue(commandAlias);
    resolveManifestToolOwnerMock.mockReturnValue(toolOwner);

    const error = await runCli(cliArgs(command)).catch((cause: unknown) => cause);

    expectPolicyError(error, expectedText);
    expect((error as Error).message).not.toContain("Did you mean this?");
    expectNoDispatch();
  },
);

it("reports disabled-by-default plugin commands as expected after lazy registration", async () => {
  const { program, parseAsync } = prepareProgram();
  tryRouteCliMock.mockResolvedValueOnce(false);
  resolvePluginCliRootOwnerIdsMock.mockReturnValue(["workboard"]);
  resolveManifestCommandAliasOwnerMock.mockReturnValue({
    pluginId: "workboard",
    enabledByDefault: false,
  });

  const error = await runCli(cliArgs("workboard", "list")).catch((cause: unknown) => cause);

  expectPolicyError(
    error,
    'the "workboard" plugin, but that bundled plugin is disabled by default',
  );
  expectLazyRegistration("workboard", false, program);
  expectNoCalls(parseAsync);
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
  expectNoCalls(startProxyMock, tryRouteCliMock, registerPluginCliCommandsFromValidatedConfigMock);
});

it("keeps reserved auth command roots out of plugin command discovery", async () => {
  const argv = cliArgs("auth", "--help");
  const { program, parseAsync } = prepareProgram();

  await runCli(argv);

  expect(startProxyMock).not.toHaveBeenCalled();
  expect(registerSubCliByNameMock.mock.calls).toEqual([[program, argv[2], argv]]);
  expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  expect(parseAsync).toHaveBeenCalledWith(argv);
});

it.each([false, true])("routes plugin logs with pass-through JSON: %s", async (passThrough) => {
  tryRouteCliMock.mockResolvedValueOnce(false);
  ownPluginRoot("memory");
  const stderr = { registration: passThrough, parse: passThrough };
  registerPluginCliCommandsFromValidatedConfigMock.mockImplementationOnce(async () => {
    stderr.registration = loggingState.forceConsoleToStderr;
    return {};
  });
  const parseAsync = vi.fn().mockImplementationOnce(async () => {
    stderr.parse = loggingState.forceConsoleToStderr;
  });
  prepareProgram(undefined, parseAsync);
  await runCli(
    cliArgs("memory", ...(passThrough ? ["--", "--json"] : ["search", "query", "--json"])),
  );
  expectLazyRegistration("memory", !passThrough);
  expect(stderr).toEqual({ registration: !passThrough, parse: !passThrough });
  if (passThrough) {
    const session = createPluginCliLoadSessionMock.mock.results.at(-1)?.value;
    expect(session?.close.mock.invocationCallOrder[0]).toBeLessThan(
      parseAsync.mock.invocationCallOrder[0]!,
    );
  }
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

it("loads the real primary command before rendering command help", async () => {
  const { program } = prepareProgram("doctor");
  const ctx = { programVersion: "0.0.0-test" };
  getProgramContextMock.mockReturnValueOnce(ctx as never);

  const argv = cliArgs("doctor", "--help");
  await runCli(argv);

  expect(registerCoreCliByNameMock.mock.calls).toEqual([[program, ctx, "doctor"]]);
  expect(registerSubCliByNameMock.mock.calls).toEqual([[program, "doctor", argv]]);
});

it.each([
  ["config", [], {}],
  ["models", ["aliases", "list", "--plain"], { enabled: false }],
] as const)("sets startup progress for %s %j", async (primary, args, progress) => {
  tryRouteCliMock.mockResolvedValueOnce(false);
  const parseAsync = vi.fn(async () => expect(progressDoneMock).toHaveBeenCalled());
  prepareProgram(primary, parseAsync);
  const argv = cliArgs(primary, ...args);
  await runCli(argv);
  expect(createCliProgressMock).toHaveBeenCalledWith({
    label: "Loading OpenClaw CLI…",
    indeterminate: true,
    delayMs: 0,
    ...progress,
  });
  expect(parseAsync).toHaveBeenCalledWith(argv);
});

it("keeps models status plain output free of proxy startup", async () => {
  tryRouteCliMock.mockResolvedValueOnce(true);
  await runCli(cliArgs("models", "--status-plain"));
  expectNoCalls(startProxyMock, stopProxyMock);
});
