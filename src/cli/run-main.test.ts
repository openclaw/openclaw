import "../test-utils/prepare-compiled-subprocesses.js";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveManifestCommandAliasOwnerInRegistry } from "../plugins/manifest-command-aliases.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv } from "../test-utils/env.js";
import { rewriteUpdateFlagArgv } from "./argv.js";
import { resolveGatewayCommandPath } from "./gateway-run-argv.js";
import {
  isGatewayRunFastPathArgv,
  resolveMissingPluginCommandMessage,
  shouldUseRootHelpFastPath,
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
vi.mock("../infra/sqlite-runtime-initialize.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-runtime-initialize.js")>()),
  initializeSqliteRuntime: sqliteAdmission.initialize,
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

it.each([
  ["gateway", true],
  ["gateway --force", true],
  ["gateway --port 18789", true],
  ["gateway --auth=none", true],
  ["--no-color gateway --bind loopback", true],
  ["gateway run", true],
  ["gateway --log-level debug run", false],
  ["gateway call health", false],
  ["gateway --help", false],
  ["gateway --port", false],
  ["gateway --unknown", false],
  ["gateway --update-canary=true", false],
] as const)("Gateway fast path: %s -> %s", (args, expected) => {
  expect(isGatewayRunFastPathArgv(cliArgs(...args.split(" ")))).toBe(expected);
});

describe("root startup policy", () => {
  it.each([
    ["--profile p --update", "--profile p update"],
    ["-- --update"],
    ["config set update.channel --update"],
  ])("rewrites only a root update flag: %s", (args, expected = args) => {
    expect(rewriteUpdateFlagArgv(cliArgs(...args.split(" ")))).toEqual(
      cliArgs(...expected.split(" ")),
    );
  });

  it("uses root help only for root invocations and aliases", () => {
    expect(shouldUseRootHelpFastPath(cliArgs("--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("help", "--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("tools", "--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("status", "--help"))).toBe(false);
    expect(shouldUseRootHelpFastPath(cliArgs("--help", "status"))).toBe(false);
    expect(shouldUseRootHelpFastPath(cliArgs("help", "gateway"))).toBe(false);
  });
});

describe("plugin command policy", () => {
  it("reports a disabled root without an alias record", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: { entries: { browser: { enabled: false } } },
      }),
    ).toContain("plugins.entries.browser.enabled=false");
  });

  it.each<[string, string, boolean, OpenClawConfig]>([
    [
      "voicecall",
      "voice-call",
      false,
      { plugins: { entries: { "voice-call": { enabled: true } } } },
    ],
    ["wiki", "memory-wiki", true, { plugins: { allow: ["memory-wiki"] } }],
  ])("accepts enabled parent ownership for %s", (command, id, enabledByDefault, config) => {
    expect(
      resolveMissingPluginCommandMessage(command, config, {
        resolveCommandAliasOwner: ({ command: name }) =>
          resolveManifestCommandAliasOwnerInRegistry({
            command: name,
            registry: { plugins: [{ id, enabledByDefault, commandAliases: [{ name: command }] }] },
          }),
      }),
    ).toBeNull();
  });
});

it.each([
  ["gateway --log-level debug run", "run"],
  ["gateway --log-level=debug restart-handoff capabilities", "restart-handoff"],
])("keeps post-root log levels out of %s", (args, command) => {
  expect(resolveGatewayCommandPath(cliArgs(...args.split(" ")))).toEqual(["gateway", command]);
});

it("keeps reserved non-plugin roots out of plugin allowlist diagnostics", () => {
  expect(
    resolveMissingPluginCommandMessage("auth", { plugins: { allow: ["browser"] } }),
  ).toBeNull();
});
