import "../test-utils/prepare-compiled-subprocesses.js";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  resolveManifestToolOwnerInRegistry,
  type PluginManifestCommandAliasRegistry,
} from "../plugins/manifest-command-aliases.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  resolveGatewayCatalogCommandPath,
  resolveGatewayRunPreBootstrapOptions,
} from "./gateway-run-argv.js";
import {
  isGatewayRunFastPathArgv,
  rewriteUpdateFlagArgv,
  resolveMissingPluginCommandMessage,
  shouldHandleBareRoot,
  shouldStartProxyForCli,
  shouldUseRootHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";
import { runCli } from "./run-main.js";

const cliArgs = (...args: string[]) => ["node", "openclaw", ...args];
vi.mock("node:process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:process")>()),
  // Stock Bun cannot clear its nonconfigurable native exitCode accessor after help sets zero.
  default: Object.create(globalThis.process, {
    exitCode: { value: undefined, writable: true, enumerable: true, configurable: true },
  }),
}));
const runGatewayCommand = vi.hoisted(() => vi.fn());
const sqliteAdmission = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>().mockResolvedValue(),
  selectGatewayEnvironment: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
}));
vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bun-sqlite-library.js")>()),
  initializeSqliteRuntimeCapabilities: sqliteAdmission.initialize,
}));
vi.mock("./gateway-cli/run.js", () => ({ runGatewayCommand }));
// Keep Commander parsing independent of native startup; run-main.exit and
// command-execution-startup tests own bootstrap and admission behavior.
vi.mock("./gateway-cli/pre-bootstrap.js", () => ({
  selectGatewayRunEnvironment: sqliteAdmission.selectGatewayEnvironment,
  prepareGatewayRunBootstrap: async () => false,
  recheckGatewayRunBootstrap: async () => {
    throw new Error("Commander parsing fixture unexpectedly rechecked Gateway bootstrap");
  },
  reloadTrustedGatewayRunEnvironment: async () => {
    throw new Error("Commander parsing fixture unexpectedly reloaded Gateway environment");
  },
}));
vi.mock("../state/agent-database-startup.js", () => ({
  withAgentDatabaseStartupAdmission: <T>(run: () => Promise<T>) => run(),
}));
vi.mock("./command-execution-startup.js", () => ({
  ensureCliExecutionBootstrap: async () => {
    throw new Error("Commander parsing fixture unexpectedly entered CLI bootstrap");
  },
}));
vi.mock("../logging/console.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/console.js")>()),
  enableConsoleCapture: vi.fn(),
}));

describe("CLI host admission and Gateway fast-path parsing", () => {
  const previousExitCode = process.exitCode;
  beforeEach(() => {
    process.exitCode = undefined;
    runGatewayCommand.mockClear();
    sqliteAdmission.initialize.mockReset().mockResolvedValue();
    sqliteAdmission.selectGatewayEnvironment.mockClear();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it("awaits SQLite admission before Gateway environment selection can read state", async () => {
    const entered = createDeferredCore();
    const decided = createDeferredCore();
    sqliteAdmission.initialize.mockImplementationOnce(() => {
      entered.resolve();
      return decided.promise;
    });
    const starting = runCli(cliArgs("gateway", "run"));
    try {
      await Promise.race([entered.promise, starting]);
      expect(sqliteAdmission.initialize).toHaveBeenCalledOnce();
      expect(sqliteAdmission.selectGatewayEnvironment).not.toHaveBeenCalled();
      expect(runGatewayCommand).not.toHaveBeenCalled();
    } finally {
      decided.resolve();
      await starting;
    }
    expect(sqliteAdmission.selectGatewayEnvironment).toHaveBeenCalledOnce();
    expect(runGatewayCommand).toHaveBeenCalledOnce();
  });

  it.each([["node", "run"], ["node", "worker"], ["worker"]])(
    "admits the long-lived host before CLI bootstrap: %j",
    async (...args) => {
      const stopped = new Error("SQLite admission reached before host bootstrap");
      sqliteAdmission.initialize.mockRejectedValueOnce(stopped);
      await expect(runCli(cliArgs(...args))).rejects.toBe(stopped);
      expect(sqliteAdmission.initialize).toHaveBeenCalledOnce();
    },
  );

  it.each([["gateway"], ["gateway", "status"], ["node", "run"], ["worker"], ["config", "get"]])(
    "keeps help paths free of SQLite capability admission: %j",
    async (...args) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await runCli(cliArgs(...args, "--help"));
      expect(sqliteAdmission.initialize).not.toHaveBeenCalled();
    },
  );

  it("keeps version output free of SQLite capability admission", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCli(cliArgs("--version"));
    expect(sqliteAdmission.initialize).not.toHaveBeenCalled();
  });

  it.each([
    ["--update-canary", "--no-color", "run"],
    ["run", "--update-canary", "--no-color"],
  ])("accepts no-color beside a boolean flag: %j", async (...args) => {
    await runCli(cliArgs("gateway", ...args, "--token=--no-color"));
    expect(process.exitCode).toBeUndefined();
    expect(runGatewayCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ updateCanary: true, token: "--no-color" }),
      expect.any(Object),
    );
  });
});

describe("Gateway argv boundaries", () => {
  it("matches only plain foreground starts without root options or help", () => {
    expect(isGatewayRunFastPathArgv(cliArgs("gateway"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--force"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--port", "18789"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--auth=none"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("--no-color", "gateway", "--bind", "loopback"))).toBe(
      true,
    );
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "run"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--log-level", "debug", "run"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "call", "health"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--help"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--port"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--unknown"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--update-canary=true"))).toBe(false);
  });

  it("resolves destructive flags after root options without consuming option values", () => {
    expect(
      resolveGatewayRunPreBootstrapOptions(
        cliArgs("--log-level", "debug", "gateway", "run", "--force", "--reset"),
      ),
    ).toEqual({ force: true, reset: true });
    expect(resolveGatewayRunPreBootstrapOptions(cliArgs("gateway", "--token", "--force"))).toEqual({
      force: false,
      reset: false,
    });
  });

  it.each([
    { args: ["--", "gateway", "--force"], commandPath: ["gateway", "--force"] },
    { args: ["gateway", "--", "run", "--force"], commandPath: ["gateway", "run"] },
    { args: ["gateway", "run", "--", "--reset"], commandPath: ["gateway", "run"] },
  ])("preserves literal commands without destructive flags: $args", ({ args, commandPath }) => {
    const argv = cliArgs(...args);
    expect(resolveGatewayCatalogCommandPath(argv)).toEqual(commandPath);
    const options = resolveGatewayRunPreBootstrapOptions(argv);
    expect(options?.force).not.toBe(true);
    expect(options?.reset).not.toBe(true);
  });
});

describe("root startup policy", () => {
  it.each([
    { args: ["--profile", "p", "--update"], expected: ["--profile", "p", "update"] },
    { args: ["--", "--update"], expected: ["--", "--update"] },
    {
      args: ["config", "set", "update.channel", "--update"],
      expected: ["config", "set", "update.channel", "--update"],
    },
  ])("rewrites only a root update flag: $args", ({ args, expected }) => {
    expect(rewriteUpdateFlagArgv(cliArgs(...args))).toEqual(cliArgs(...expected));
  });

  it.each([["--profile", "work", "--", "config", "get", "gateway.mode"]])(
    "does not launch bare-root flows for literal commands: %j",
    (...args) => {
      const argv = cliArgs(...args);
      expect(shouldHandleBareRoot(argv)).toBe(false);
      expect(shouldUseRootHelpFastPath(argv)).toBe(false);
    },
  );

  it("skips proxy startup before SQLite maintenance", () => {
    expect(shouldStartProxyForCli(cliArgs("doctor", "--state-sqlite", "compact", "--json"))).toBe(
      false,
    );
    expect(shouldStartProxyForCli(cliArgs("doctor", "--state-sqlite=compact", "--json"))).toBe(
      false,
    );
    expect(shouldStartProxyForCli(cliArgs("doctor", "--lint"))).toBe(true);
  });

  it("uses root help only for root invocations and aliases", () => {
    expect(shouldUseRootHelpFastPath(cliArgs("--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("help", "--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("tools", "--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("status", "--help"))).toBe(false);
    expect(shouldUseRootHelpFastPath(cliArgs("--help", "status"))).toBe(false);
    expect(shouldUseRootHelpFastPath(cliArgs("help", "gateway"))).toBe(false);
  });

  it("keeps setup help behind unambiguous argument parsing", () => {
    expect(shouldUseSetupOnboardConfigureHelpFastPath(cliArgs("setup", "--help"))).toBe(true);
    expect(shouldUseSetupOnboardConfigureHelpFastPath(cliArgs("onboard", "status", "--help"))).toBe(
      false,
    );
    expect(
      shouldUseSetupOnboardConfigureHelpFastPath(cliArgs("onboard", "--gateway-port", "--help")),
    ).toBe(false);
  });
});

function commandResolvers(registry: PluginManifestCommandAliasRegistry) {
  return {
    resolveCommandAliasOwner: ({ command }: { command: string | undefined }) =>
      resolveManifestCommandAliasOwnerInRegistry({ command, registry }),
    resolveToolOwner: ({ toolName }: { toolName: string | undefined }) =>
      resolveManifestToolOwnerInRegistry({ toolName, registry }),
  };
}

describe("plugin command policy", () => {
  it("reports a disabled root without an alias record", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: { entries: { browser: { enabled: false } } },
      }),
    ).toContain("plugins.entries.browser.enabled=false");
  });

  it.each([
    {
      command: "voicecall",
      plugin: { id: "voice-call", commandAliases: [{ name: "voicecall" }] },
      config: { plugins: { entries: { "voice-call": { enabled: true } } } },
    },
    {
      command: "wiki",
      plugin: { id: "memory-wiki", enabledByDefault: true, commandAliases: [{ name: "wiki" }] },
      config: { plugins: { allow: ["memory-wiki"] } },
    },
  ])("accepts enabled parent ownership for $command", ({ command, plugin, config }) => {
    expect(
      resolveMissingPluginCommandMessage(command, config, commandResolvers({ plugins: [plugin] })),
    ).toBeNull();
  });
});

it("keeps post-root log levels out of the gateway command path", () => {
  expect(
    resolveGatewayCatalogCommandPath(cliArgs("gateway", "--log-level", "debug", "run")),
  ).toEqual(["gateway", "run"]);
  expect(
    resolveGatewayCatalogCommandPath(
      cliArgs("gateway", "--log-level=debug", "restart-handoff", "capabilities"),
    ),
  ).toEqual(["gateway", "restart-handoff"]);
});

it("keeps reserved non-plugin roots out of plugin allowlist diagnostics", () => {
  expect(
    resolveMissingPluginCommandMessage("auth", { plugins: { allow: ["browser"] } }),
  ).toBeNull();
});
