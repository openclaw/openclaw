// Run main tests cover CLI main entrypoint behavior and process error handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveManifestCommandAliasOwnerInRegistry,
  resolveManifestToolOwnerInRegistry,
  type PluginManifestCommandAliasRegistry,
} from "../plugins/manifest-command-aliases.js";
import {
  resolveGatewayCatalogCommandPath,
  resolveGatewayRunPreBootstrapOptions,
} from "./gateway-run-argv.js";
import {
  rewriteUpdateFlagArgv,
  resolveMissingPluginCommandMessage,
  shouldHandleBareRoot,
  shouldEnsureCliPath,
  shouldStartProxyForCli,
  shouldUseRootHelpFastPath,
  shouldUseSetupOnboardConfigureHelpFastPath,
} from "./run-main-policy.js";
import { isGatewayRunFastPathArgv, runCli } from "./run-main.js";

const cliArgs = (...args: string[]) => ["node", "openclaw", ...args];

const runGatewayCommand = vi.hoisted(() => vi.fn());

vi.mock("./gateway-cli/run.js", () => ({ runGatewayCommand }));
vi.mock("./gateway-cli/pre-bootstrap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-cli/pre-bootstrap.js")>()),
  selectGatewayRunEnvironment: async () => true,
  prepareGatewayRunBootstrap: async () => false,
}));
vi.mock("../logging/console.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/console.js")>()),
  enableConsoleCapture: vi.fn(),
}));

describe("Gateway fast-path Commander parsing", () => {
  const previousExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    runGatewayCommand.mockClear();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it.each([
    { flag: "--ambient-channels", key: "ambientChannels" },
    { flag: "--dev-ambient-channels", key: "devAmbientChannels" },
    { flag: "--verbose", key: "verbose" },
    { flag: "--update-canary", key: "updateCanary" },
  ])("accepts root no-color after $flag on parent and child", async ({ flag, key }) => {
    for (const args of [
      [flag, "--no-color", "run"],
      ["run", flag, "--no-color"],
    ]) {
      runGatewayCommand.mockClear();
      await runCli(cliArgs("gateway", ...args, "--token=--no-color"));

      expect(process.exitCode).toBeUndefined();
      expect(runGatewayCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ [key]: true, token: "--no-color" }),
        expect.any(Object),
      );
    }
  });
});

const memoryWikiCommandAliasRegistry: PluginManifestCommandAliasRegistry = {
  plugins: [
    {
      id: "memory-wiki",
      enabledByDefault: true,
      commandAliases: [{ name: "wiki" }],
    },
  ],
};

const memoryCoreCommandAliasRegistry: PluginManifestCommandAliasRegistry = {
  plugins: [
    {
      id: "memory-core",
      commandAliases: [{ name: "dreaming", kind: "runtime-slash", cliCommand: "memory" }],
    },
  ],
};

const losslessClawToolRegistry: PluginManifestCommandAliasRegistry = {
  plugins: [
    {
      id: "lossless-claw",
      contracts: { tools: ["lcm_recent", "lcm_search"] },
    },
  ],
};

const browserCommandAliasRegistry: PluginManifestCommandAliasRegistry = {
  plugins: [
    {
      id: "browser",
      enabledByDefault: true,
      commandAliases: [{ name: "browser" }],
    },
  ],
};

describe("isGatewayRunFastPathArgv", () => {
  it.each([
    { args: ["--update-canary"], commandPath: ["gateway"] },
    { args: ["--update-canary", "run"], commandPath: ["gateway", "run"] },
    { args: ["run", "--update-canary"], commandPath: ["gateway", "run"] },
  ])("keeps update canaries on the foreground startup path: $args", ({ args, commandPath }) => {
    const argv = ["node", "openclaw", "gateway", ...args, "--bind", "loopback", "--port", "14720"];
    expect(isGatewayRunFastPathArgv(argv)).toBe(true);
    expect(resolveGatewayCatalogCommandPath(argv)).toEqual(commandPath);
  });

  it("matches only plain gateway foreground starts without root options or help", () => {
    expect(isGatewayRunFastPathArgv(cliArgs("gateway"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--force"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--port", "18789"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--auth=none"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("--no-color", "gateway", "--bind", "loopback"))).toBe(
      true,
    );
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "run"))).toBe(true);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--log-level", "debug", "run"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--log-level=debug", "run"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "run", "--raw-stream-path", "x"))).toBe(
      true,
    );
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "call", "health"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--help"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--port"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--unknown"))).toBe(false);
    expect(isGatewayRunFastPathArgv(cliArgs("gateway", "--update-canary=true"))).toBe(false);
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
});

describe("resolveGatewayRunPreBootstrapOptions", () => {
  it("resolves destructive gateway flags across fast and full Commander paths", () => {
    expect(resolveGatewayRunPreBootstrapOptions(cliArgs("gateway", "run", "--force"))).toEqual({
      force: true,
      reset: false,
    });
    expect(
      resolveGatewayRunPreBootstrapOptions(
        cliArgs("--log-level", "debug", "gateway", "run", "--force", "--reset"),
      ),
    ).toEqual({ force: true, reset: true });
  });

  it("does not treat malformed required option values as destructive flags", () => {
    expect(resolveGatewayRunPreBootstrapOptions(cliArgs("gateway", "--token", "--force"))).toEqual({
      force: false,
      reset: false,
    });
  });

  it.each([
    { args: ["--", "gateway", "status"], commandPath: ["gateway", "status"] },
    { args: ["gateway", "--", "status"], commandPath: ["gateway", "status"] },
    { args: ["--", "gateway", "--force"], commandPath: ["gateway", "--force"] },
    { args: ["--", "gateway", "run", "--reset"], commandPath: ["gateway", "run"] },
    { args: ["gateway", "--", "run", "--force"], commandPath: ["gateway", "run"] },
    { args: ["gateway", "run", "--", "--reset"], commandPath: ["gateway", "run"] },
  ])(
    "preserves literal gateway commands without enabling destructive flags: $args",
    ({ args, commandPath }) => {
      const argv = cliArgs(...args);
      expect(resolveGatewayCatalogCommandPath(argv)).toEqual(commandPath);
      const options = resolveGatewayRunPreBootstrapOptions(argv);
      expect(options?.force).not.toBe(true);
      expect(options?.reset).not.toBe(true);
    },
  );
});

describe("rewriteUpdateFlagArgv", () => {
  it("leaves argv unchanged when --update is absent", () => {
    const argv = ["node", "entry.js", "status"];
    expect(rewriteUpdateFlagArgv(argv)).toBe(argv);
  });

  it("preserves global flags that appear before --update", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--profile", "p", "--update"])).toEqual([
      "node",
      "entry.js",
      "--profile",
      "p",
      "update",
    ]);
  });

  it("keeps update options after the rewritten command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update", "--json"])).toEqual([
      "node",
      "entry.js",
      "update",
      "--json",
    ]);
  });

  it("does not rewrite --update after -- positional terminator", () => {
    expect(
      rewriteUpdateFlagArgv(["node", "entry.js", "config", "set", "foo", "--", "--update"]),
    ).toEqual(["node", "entry.js", "config", "set", "foo", "--", "--update"]);
  });

  it("does not rewrite --update when a subcommand appears before it", () => {
    expect(
      rewriteUpdateFlagArgv(["node", "entry.js", "config", "set", "update.channel", "--update"]),
    ).toEqual(["node", "entry.js", "config", "set", "update.channel", "--update"]);
  });

  it("rewrites --update after root boolean flags", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--no-color", "--update"])).toEqual([
      "node",
      "entry.js",
      "--no-color",
      "update",
    ]);
  });

  it("does not skip root boolean flag followers as option values", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--no-color", "status", "--update"])).toEqual(
      ["node", "entry.js", "--no-color", "status", "--update"],
    );
  });

  it("rewrites --update past a root value flag given an empty string value", () => {
    // Regression: a bare empty-string value token (e.g. `--profile ""`) used to be
    // under-consumed, leaving "" as its own token that hit the `!arg` guard and made
    // this function bail out before reaching --update.
    expect(
      rewriteUpdateFlagArgv(["node", "entry.js", "--profile", "", "--update"]),
    ).toEqual(["node", "entry.js", "--profile", "", "update"]);
  });
});

describe("shouldEnsureCliPath", () => {
  it("skips path bootstrap for help/version invocations", () => {
    expect(shouldEnsureCliPath(cliArgs("--help"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("-V"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("-v"))).toBe(false);
  });

  it("skips path bootstrap for read-only fast paths", () => {
    expect(shouldEnsureCliPath(cliArgs())).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("--profile", "work"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("approvals"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("channels"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("cron"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("devices"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("plugins"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("mcp"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("status"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("--log-level", "debug", "status"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("sessions", "--json"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("config", "get", "update"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("models", "status", "--json"))).toBe(false);
    expect(shouldEnsureCliPath(cliArgs("tools", "effective"))).toBe(false);
  });

  it("keeps path bootstrap for mutating or unknown commands", () => {
    expect(shouldEnsureCliPath(cliArgs("message", "send"))).toBe(true);
    expect(shouldEnsureCliPath(cliArgs("voicecall", "status"))).toBe(true);
    expect(shouldEnsureCliPath(cliArgs("acp", "-v"))).toBe(true);
  });
});

describe("shouldHandleBareRoot", () => {
  it("handles bare root invocations", () => {
    expect(shouldHandleBareRoot(cliArgs())).toBe(true);
    expect(shouldHandleBareRoot(cliArgs("--profile", "work"))).toBe(true);
    expect(shouldHandleBareRoot(cliArgs("--dev"))).toBe(true);
  });

  it("does not handle help, version, or commands", () => {
    expect(shouldHandleBareRoot(cliArgs("--help"))).toBe(false);
    expect(shouldHandleBareRoot(cliArgs("-V"))).toBe(false);
    expect(shouldHandleBareRoot(cliArgs("status"))).toBe(false);
  });

  it.each([
    ["--unknown"],
    ["--no-color", "--unknown"],
    ["--unknown=value"],
    ["--json"],
    ["--profile"],
    ["--log-level"],
    [""],
  ])("leaves invalid root arguments to Commander: %j", (...args) => {
    expect(shouldHandleBareRoot(cliArgs(...args))).toBe(false);
  });

  it.each([
    { args: ["--", "config", "get", "gateway.mode"] },
    { args: ["--profile", "work", "--", "config", "get", "gateway.mode"] },
    { args: ["--", "--help"] },
    { args: ["--", "config", "--help"] },
    { args: ["--", "config", "unknown"] },
  ])("does not start bare-root flows for literal commands: $args", ({ args }) => {
    const argv = cliArgs(...args);
    expect(shouldHandleBareRoot(argv)).toBe(false);
    expect(shouldUseRootHelpFastPath(argv)).toBe(false);
  });

  it("retains bare-root behavior for an otherwise empty terminator", () => {
    expect(shouldHandleBareRoot(cliArgs("--"))).toBe(true);
  });
});

describe("shouldStartProxyForCli", () => {
  it("starts managed proxy routing for the --update shorthand", () => {
    expect(shouldStartProxyForCli(cliArgs("--update"))).toBe(true);
    expect(shouldStartProxyForCli(cliArgs("--profile", "p", "--update"))).toBe(true);
  });

  it("skips managed proxy routing for bare parent default help", () => {
    expect(shouldStartProxyForCli(cliArgs("qa", "suite"))).toBe(false);
    expect(shouldStartProxyForCli(cliArgs("plugins"))).toBe(false);
    expect(shouldStartProxyForCli(cliArgs("channels"))).toBe(false);
    expect(shouldStartProxyForCli(cliArgs("cron"))).toBe(false);
    expect(shouldStartProxyForCli(cliArgs("devices"))).toBe(false);
    expect(shouldStartProxyForCli(cliArgs("mcp"))).toBe(false);
  });

  it("skips managed proxy routing before shared-state SQLite maintenance", () => {
    expect(shouldStartProxyForCli(cliArgs("doctor", "--state-sqlite", "compact", "--json"))).toBe(
      false,
    );
    expect(shouldStartProxyForCli(cliArgs("doctor", "--state-sqlite=compact", "--json"))).toBe(
      false,
    );
    expect(shouldStartProxyForCli(cliArgs("doctor", "--lint"))).toBe(true);
  });
});

describe("shouldUseRootHelpFastPath", () => {
  it("uses the fast path for root help only", () => {
    expect(shouldUseRootHelpFastPath(cliArgs("--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("--profile", "work", "-h"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("help", "--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("tools", "--help"))).toBe(true);
    expect(shouldUseRootHelpFastPath(cliArgs("status", "--help"))).toBe(false);
    expect(shouldUseRootHelpFastPath(cliArgs("--help", "status"))).toBe(false);
    expect(shouldUseRootHelpFastPath(cliArgs("help", "gateway"))).toBe(false);
  });
});

describe("shouldUseSetupOnboardConfigureHelpFastPath", () => {
  it("uses the fast path only for setup, onboard, and configure help", () => {
    expect(shouldUseSetupOnboardConfigureHelpFastPath(cliArgs("setup", "--help"))).toBe(true);
    expect(shouldUseSetupOnboardConfigureHelpFastPath(cliArgs("onboard", "-h"))).toBe(true);
    expect(
      shouldUseSetupOnboardConfigureHelpFastPath(cliArgs("--profile", "work", "configure", "-h")),
    ).toBe(true);
    expect(shouldUseSetupOnboardConfigureHelpFastPath(cliArgs("onboard", "status", "--help"))).toBe(
      false,
    );
    expect(shouldUseSetupOnboardConfigureHelpFastPath(cliArgs("status", "--help"))).toBe(false);
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

describe("resolveMissingPluginCommandMessage", () => {
  it("explains plugins.allow misses for a bundled plugin command", () => {
    expect(
      resolveMissingPluginCommandMessage(
        "browser",
        {
          plugins: {
            allow: ["quietchat"],
          },
        },
        commandResolvers(browserCommandAliasRegistry),
      ),
    ).toBe(
      'The `openclaw browser` command is unavailable because `plugins.allow` excludes "browser". Add "browser" to `plugins.allow` if you want that bundled plugin CLI surface.',
    );
  });

  it("explains explicit bundled plugin disablement", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: {
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      }),
    ).toBe(
      "The `openclaw browser` command is unavailable because `plugins.entries.browser.enabled=false`. Re-enable that entry if you want the bundled plugin CLI surface.",
    );
  });

  it("returns null when the bundled plugin command is already allowed", () => {
    expect(
      resolveMissingPluginCommandMessage("browser", {
        plugins: {
          allow: ["browser"],
        },
      }),
    ).toBeNull();
  });

  it("does not classify reserved non-plugin command roots as plugin allowlist misses", () => {
    for (const root of ["auth", "tool"]) {
      const message = resolveMissingPluginCommandMessage(root, {
        plugins: {
          allow: ["browser"],
        },
      });
      expect(message).toBeNull();
    }
  });

  it("returns the runtime command message even when plugins.allow is set", () => {
    const message = resolveMissingPluginCommandMessage(
      "dreaming",
      {
        plugins: {
          allow: ["memory-core"],
        },
      },
      commandResolvers(memoryCoreCommandAliasRegistry),
    );
    expect(message).toBe(
      '"dreaming" is a runtime slash command (/dreaming), not a CLI command. It is provided by the "memory-core" plugin. Use `openclaw memory` for related CLI operations, or `/dreaming` in a chat session.',
    );
  });

  it("points command names in plugins.allow at their parent plugin", () => {
    const message = resolveMissingPluginCommandMessage(
      "dreaming",
      {
        plugins: {
          allow: ["dreaming"],
        },
      },
      commandResolvers(memoryCoreCommandAliasRegistry),
    );
    expect(message).toBe(
      '"dreaming" is not a plugin; it is a command provided by the "memory-core" plugin. Add "memory-core" to `plugins.allow` instead of "dreaming".',
    );
  });

  it("explains disabled-by-default parent plugins for CLI command aliases", () => {
    const message = resolveMissingPluginCommandMessage(
      "voicecall",
      {},
      commandResolvers({
        plugins: [
          {
            id: "voice-call",
            commandAliases: [{ name: "voicecall" }],
          },
        ],
      }),
    );

    expect(message).toContain('"voice-call" plugin');
    expect(message).toContain("disabled by default");
    expect(message).toContain("openclaw plugins enable voice-call");
  });

  it("returns null for CLI command aliases when disabled-by-default parent plugins are enabled", () => {
    const message = resolveMissingPluginCommandMessage(
      "voicecall",
      {
        plugins: {
          entries: {
            "voice-call": {
              enabled: true,
            },
          },
        },
      },
      commandResolvers({
        plugins: [
          {
            id: "voice-call",
            commandAliases: [{ name: "voicecall" }],
          },
        ],
      }),
    );

    expect(message).toBeNull();
  });

  it("explains parent plugin disablement for runtime command aliases", () => {
    const message = resolveMissingPluginCommandMessage(
      "dreaming",
      {
        plugins: {
          entries: {
            "memory-core": {
              enabled: false,
            },
          },
        },
      },
      commandResolvers(memoryCoreCommandAliasRegistry),
    );
    expect(message).toContain("plugins.entries.memory-core.enabled=false");
    expect(message).not.toContain("runtime slash command");
  });

  it("allows CLI commands when their parent plugin is in plugins.allow", () => {
    const message = resolveMissingPluginCommandMessage(
      "wiki",
      {
        plugins: {
          allow: ["memory-wiki"],
        },
      },
      commandResolvers(memoryWikiCommandAliasRegistry),
    );
    expect(message).toBeNull();
  });

  it("blocks CLI commands when parent plugin is NOT in plugins.allow", () => {
    const message = resolveMissingPluginCommandMessage(
      "wiki",
      {
        plugins: {
          allow: ["quietchat"],
        },
      },
      commandResolvers(memoryWikiCommandAliasRegistry),
    );
    expect(message).toContain('"memory-wiki"');
    expect(message).toContain("plugins.allow");
  });

  it("identifies an agent tool name and points the user at model tool-use", () => {
    const message = resolveMissingPluginCommandMessage(
      "lcm_recent",
      {
        plugins: {
          allow: ["lossless-claw"],
        },
      },
      commandResolvers(losslessClawToolRegistry),
    );
    if (message === null) {
      throw new Error("expected missing plugin command message");
    }
    expect(message).toBe(
      '"lcm_recent" is an agent tool available from the "lossless-claw" plugin, not a CLI subcommand. Use it from an agent turn (model tool-use), not the CLI. Run `openclaw --help` to see available CLI subcommands.',
    );
  });

  it("returns null for unknown names excluded by plugins.allow", () => {
    const message = resolveMissingPluginCommandMessage(
      "totally-unknown",
      {
        plugins: {
          allow: ["quietchat"],
        },
      },
      commandResolvers(losslessClawToolRegistry),
    );
    expect(message).toBeNull();
  });

  it("points metadata-only CLI roots in plugins.allow at their parent plugin", () => {
    const message = resolveMissingPluginCommandMessage(
      "qa",
      {
        plugins: {
          allow: ["browser"],
        },
      },
      {
        resolveCliCommandSurfaceOwner: () => "qa-lab",
      },
    );
    expect(message).toContain('"qa" is not a plugin');
    expect(message).toContain('"qa-lab"');
    expect(message).toContain('Add "qa-lab" to `plugins.allow` instead of "qa"');
  });

  it("does not attribute a tool to an owning plugin excluded by plugins.allow", () => {
    // The owning plugin is denied via plugins.allow, so the manifest-declared
    // tool is not available through the owning plugin. Tool names are not CLI
    // command surfaces, so do not suggest adding the tool name to plugins.allow.
    const message = resolveMissingPluginCommandMessage(
      "lcm_recent",
      {
        plugins: {
          allow: ["quietchat"],
        },
      },
      commandResolvers(losslessClawToolRegistry),
    );
    expect(message).toBeNull();
  });

  it("does not attribute a tool to an owning plugin disabled via plugins.entries", () => {
    const message = resolveMissingPluginCommandMessage(
      "lcm_recent",
      {
        plugins: {
          entries: {
            "lossless-claw": { enabled: false },
          },
        },
      },
      commandResolvers(losslessClawToolRegistry),
    );
    // entries.<id>.enabled = false on the OWNING plugin invalidates the
    // plugin-tool attribution. With no allow filter on the bare name the
    // diagnostic returns null (no actionable message); callers handle that
    // as "not a recognised plugin command".
    expect(message).toBeNull();
  });

  it("uses softer 'may be provided by' wording for manifest-only availability", () => {
    // Some runtime gates (per-account enabled, per-tool toggles in the Feishu
    // family etc.) cannot be expressed as manifest configSignals, so the
    // runtime resolver reports availability: "manifest-only" when ownership is
    // only manifest-provable. The diagnostic must avoid asserting "registered
    // by" in that case.
    const manifestOnlyOwner = {
      toolName: "feishu_chat",
      pluginId: "feishu",
      availability: "manifest-only" as const,
    };
    const message = resolveMissingPluginCommandMessage("feishu_chat", undefined, {
      resolveToolOwner: () => manifestOnlyOwner,
    });
    if (message === null) {
      throw new Error("expected missing plugin command message");
    }
    expect(message).toBe(
      '"feishu_chat" may be provided by the "feishu" plugin as an agent tool, not a CLI subcommand. Run `openclaw --help` to see available CLI subcommands.',
    );
  });
});
