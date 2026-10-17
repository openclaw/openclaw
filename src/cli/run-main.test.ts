import "../test-utils/prepare-compiled-subprocesses.js";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  type PluginManifestCommandAliasRegistry,
} from "../plugins/manifest-command-aliases.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv } from "../test-utils/env.js";
import { rewriteUpdateFlagArgv } from "./argv.js";
import {
  resolveGatewayCatalogCommandPath,
  resolveGatewayRunPreBootstrapOptions,
} from "./gateway-run-argv.js";
import {
  isGatewayRunFastPathArgv,
  resolveMissingPluginCommandMessage,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";
import { runCli } from "./run-main.js";

const cliArgs = (args: string) => ["node", "openclaw", ...args.split(" ")];
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
  unexpected: (stage: string) => async () => {
    throw new Error(`Commander parsing fixture unexpectedly ${stage}`);
  },
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
  recheckGatewayRunBootstrap: sqliteAdmission.unexpected("rechecked Gateway bootstrap"),
  reloadTrustedGatewayRunEnvironment: sqliteAdmission.unexpected("reloaded Gateway environment"),
}));
vi.mock("../state/agent-database-startup.js", () => ({
  withAgentDatabaseStartupAdmission: <T>(run: () => Promise<T>) => run(),
}));
vi.mock("./command-execution-startup.js", () => ({
  ensureCliExecutionBootstrap: sqliteAdmission.unexpected("entered CLI bootstrap"),
}));
vi.mock("../logging/console.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/console.js")>()),
  enableConsoleCapture: vi.fn(),
}));

describe("CLI host admission and Gateway fast-path parsing", () => {
  const previousExitCode = process.exitCode;
  const pathEnv = captureEnv(["PATH", "OPENCLAW_PATH_BOOTSTRAPPED"]);
  beforeEach(() => {
    process.exitCode = undefined;
    runGatewayCommand.mockClear();
    sqliteAdmission.initialize.mockReset().mockResolvedValue();
    sqliteAdmission.selectGatewayEnvironment.mockClear();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    pathEnv.restore();
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
    const starting = runCli(cliArgs("gateway run"));
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

  it.each(["node run", "node worker", "worker"])(
    "admits the long-lived host before CLI bootstrap: %j",
    async (args) => {
      const stopped = new Error("SQLite admission reached before host bootstrap");
      sqliteAdmission.initialize.mockRejectedValueOnce(stopped);
      await expect(runCli(cliArgs(args))).rejects.toBe(stopped);
      expect(sqliteAdmission.initialize).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "gateway --help",
    "gateway status --help",
    "node run --help",
    "worker --help",
    "config get --help",
    "--version",
  ])("keeps help/version free of SQLite capability admission: %s", async (args) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCli(cliArgs(args));
    expect(sqliteAdmission.initialize).not.toHaveBeenCalled();
  });

  it.each(["--update-canary --no-color run", "run --update-canary --no-color"])(
    "accepts no-color beside a boolean flag: %s",
    async (args) => {
      await runCli(cliArgs(`gateway ${args} --token=--no-color`));
      expect(process.exitCode).toBeUndefined();
      expect(runGatewayCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ updateCanary: true, token: "--no-color" }),
        expect.any(Object),
      );
    },
  );
});

describe("Gateway argv boundaries", () => {
  it.each([
    [true, "gateway"],
    [true, "gateway --force"],
    [true, "gateway --port 18789"],
    [true, "gateway --auth=none"],
    [true, "--no-color gateway --bind loopback"],
    [true, "gateway run"],
    [false, "gateway --log-level debug run"],
    [false, "gateway call health"],
    [false, "gateway --help"],
    [false, "gateway --port"],
    [false, "gateway --unknown"],
    [false, "gateway --update-canary=true"],
  ] as const)("foreground admission is %s for %s", (expected, args) => {
    expect(isGatewayRunFastPathArgv(cliArgs(args))).toBe(expected);
  });

  it.each([
    ["--log-level debug gateway run --force --reset", true],
    ["gateway --token --force", false],
  ] as const)("resolves destructive flags without consuming values: %s", (args, enabled) => {
    expect(resolveGatewayRunPreBootstrapOptions(cliArgs(args))).toEqual({
      force: enabled,
      reset: enabled,
    });
  });

  it.each([
    ["-- gateway --force", "gateway --force"],
    ["gateway -- run --force", "gateway run"],
    ["gateway run -- --reset", "gateway run"],
  ])("preserves literal commands without destructive flags: %s", (args, commandPath) => {
    const argv = cliArgs(args);
    expect(resolveGatewayCatalogCommandPath(argv)).toEqual(commandPath.split(" "));
    const options = resolveGatewayRunPreBootstrapOptions(argv);
    expect(options?.force).not.toBe(true);
    expect(options?.reset).not.toBe(true);
  });
});

describe("root startup policy", () => {
  it.each([
    ["--profile p --update", "--profile p update"],
    ["-- --update", "-- --update"],
    ["config set update.channel --update", "config set update.channel --update"],
  ])("rewrites only a root update flag: %s", (args, expected) => {
    expect(rewriteUpdateFlagArgv(cliArgs(args))).toEqual(cliArgs(expected));
  });

  it.each([
    [true, "--help"],
    [true, "help --help"],
    [true, "tools --help"],
    [false, "status --help"],
    [false, "--help status"],
    [false, "help gateway"],
  ] as const)("root help is %s for %s", (expected, args) => {
    expect(shouldUseRootHelpFastPath(cliArgs(args))).toBe(expected);
  });
});

function commandResolvers(registry: PluginManifestCommandAliasRegistry) {
  return {
    resolveCommandAliasOwner: ({ command }: { command: string | undefined }) =>
      resolveManifestCommandAliasOwnerInRegistry({ command, registry }),
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
    ["voicecall", "voice-call", false],
    ["wiki", "memory-wiki", true],
  ] as const)("accepts enabled parent ownership for %s", (command, id, enabledByDefault) => {
    const plugin = { id, enabledByDefault, commandAliases: [{ name: command }] };
    const config = {
      plugins: enabledByDefault ? { allow: [id] } : { entries: { [id]: { enabled: true } } },
    };
    expect(
      resolveMissingPluginCommandMessage(command, config, commandResolvers({ plugins: [plugin] })),
    ).toBeNull();
  });
});

it("keeps post-root log levels out of the gateway command path", () => {
  expect(resolveGatewayCatalogCommandPath(cliArgs("gateway --log-level debug run"))).toEqual([
    "gateway",
    "run",
  ]);
  expect(
    resolveGatewayCatalogCommandPath(
      cliArgs("gateway --log-level=debug restart-handoff capabilities"),
    ),
  ).toEqual(["gateway", "restart-handoff"]);
});

it("keeps reserved non-plugin roots out of plugin allowlist diagnostics", () => {
  expect(
    resolveMissingPluginCommandMessage("auth", { plugins: { allow: ["browser"] } }),
  ).toBeNull();
});
