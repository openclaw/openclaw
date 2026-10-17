import "../test-utils/prepare-compiled-subprocesses.js";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveManifestCommandAliasOwnerInRegistry } from "../plugins/manifest-command-aliases.js";
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
    "admits hosts before bootstrap: %s",
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
    "accepts adjacent no-color: %s",
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

function argvCases(resolve: (argv: string[]) => unknown, cases: Record<string, unknown>) {
  return Object.entries(cases).map(([args, expected]) => ({ resolve, args, expected }));
}
it.each([
  ...argvCases(isGatewayRunFastPathArgv, {
    gateway: true,
    "gateway --force": true,
    "gateway --port 18789": true,
    "gateway --auth=none": true,
    "--no-color gateway --bind loopback": true,
    "gateway run": true,
    "gateway --log-level debug run": false,
    "gateway call health": false,
    "gateway --help": false,
    "gateway --port": false,
    "gateway --unknown": false,
    "gateway --update-canary=true": false,
  }),
  ...argvCases(resolveGatewayRunPreBootstrapOptions, {
    "--log-level debug gateway run --force --reset": { force: true, reset: true },
    "gateway --token --force": { force: false, reset: false },
  }),
  ...argvCases(rewriteUpdateFlagArgv, {
    "--profile p --update": cliArgs("--profile p update"),
    "-- --update": cliArgs("-- --update"),
    "config set update.channel --update": cliArgs("config set update.channel --update"),
  }),
  ...argvCases(shouldUseRootHelpFastPath, {
    "--help": true,
    "help --help": true,
    "tools --help": true,
    "status --help": false,
    "--help status": false,
    "help gateway": false,
  }),
  ...argvCases(resolveGatewayCatalogCommandPath, {
    "gateway --log-level debug run": ["gateway", "run"],
    "gateway --log-level=debug restart-handoff capabilities": ["gateway", "restart-handoff"],
  }),
])("$resolve.name: $args", ({ resolve, args, expected }) => {
  expect(resolve(cliArgs(args))).toEqual(expected);
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
    const registry = { plugins: [plugin] };
    expect(
      resolveMissingPluginCommandMessage(command, config, {
        resolveCommandAliasOwner: ({ command: requested }) =>
          resolveManifestCommandAliasOwnerInRegistry({ command: requested, registry }),
      }),
    ).toBeNull();
  });
});

it("keeps reserved non-plugin roots out of plugin allowlist diagnostics", () => {
  expect(
    resolveMissingPluginCommandMessage("auth", { plugins: { allow: ["browser"] } }),
  ).toBeNull();
});
