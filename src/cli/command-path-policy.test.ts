import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { CliCommandCatalogEntry, CliCommandPathPolicy } from "./command-catalog-types.js";
import {
  resolveCliCommandPathPolicy,
  resolveCliNetworkProxyPolicy,
} from "./command-path-policy.js";

const DEFAULT_EXPECTED_POLICY: CliCommandPathPolicy = {
  configGuard: "run",
  stateStoreGuard: "skip",
  loadPlugins: "never",
  pluginRegistry: { scope: "all" },
  ownsProtocolStdout: false,
  hideBanner: false,
  ensureCliPath: true,
  networkProxy: "default",
};

type NetworkProxyResolver = Extract<
  CliCommandPathPolicy["networkProxy"],
  (ctx: { argv: string[]; commandPath: string[] }) => unknown
>;
type LoadPluginsResolver = Extract<
  CliCommandPathPolicy["loadPlugins"],
  (ctx: { argv: string[]; commandPath: string[]; jsonOutputMode: boolean }) => unknown
>;
type ConfigGuardResolver = Extract<
  CliCommandPathPolicy["configGuard"],
  (ctx: { argv: string[]; commandPath: string[] }) => unknown
>;

function expectResolvedPolicy(commands: string[], expected: Partial<CliCommandPathPolicy>): void {
  for (const command of commands) {
    expect(resolveCliCommandPathPolicy(command.split(" ")), command).toEqual({
      ...DEFAULT_EXPECTED_POLICY,
      ...expected,
    });
  }
}

function expectNetworkProxyResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & { networkProxy: NetworkProxyResolver } {
  expect(typeof policy.networkProxy).toBe("function");
}

function expectLoadPluginsResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & { loadPlugins: LoadPluginsResolver } {
  expect(typeof policy.loadPlugins).toBe("function");
}

function expectConfigGuardResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & { configGuard: ConfigGuardResolver } {
  expect(typeof policy.configGuard).toBe("function");
}

function commandContext(commandPath: string[], flags: string[] = [], jsonOutputMode = false) {
  return { argv: ["node", "openclaw", ...commandPath, ...flags], commandPath, jsonOutputMode };
}

function expectProxy(args: string[], expected: "default" | "bypass") {
  expect(resolveCliNetworkProxyPolicy(["node", "openclaw", ...args]), args.join(" ")).toBe(
    expected,
  );
}

describe("command-path-policy", () => {
  it("keeps config-only agent commands on config-only startup", () => {
    const agentPolicy = resolveCliCommandPathPolicy(["agent"]);
    expect(agentPolicy).toEqual({
      ...DEFAULT_EXPECTED_POLICY,
      configGuard: agentPolicy.configGuard,
      loadPlugins: agentPolicy.loadPlugins,
      pluginRegistry: { scope: "all" },
      networkProxy: agentPolicy.networkProxy,
    });
    expectLoadPluginsResolver(agentPolicy);
    expectConfigGuardResolver(agentPolicy);
    expect(agentPolicy.loadPlugins(commandContext(["agent"]))).toBe(false);
    expect(agentPolicy.loadPlugins(commandContext(["agent"], ["--json"], true))).toBe(false);
    expect(agentPolicy.loadPlugins(commandContext(["agent"], ["--local"], true))).toBe(true);
    expect(agentPolicy.configGuard(commandContext(["agent"]))).toBe("skip");
    expect(agentPolicy.configGuard(commandContext(["agent"], ["--local"]))).toBe("run");
    expectResolvedPolicy(["agent exec"], {
      configGuard: "skip",
      ownsProtocolStdout: true,
      hideBanner: true,
    });

    expectResolvedPolicy(["agents", "agents list", "agents bindings"], {
      configGuard: "skip",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["agents add", "agents team create"], {
      configGuard: "defer",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["agents bind", "agents unbind", "agents set-identity", "agents delete"], {
      networkProxy: "bypass",
    });
  });

  it("loads only sandbox backend owner plugins for runtime commands", () => {
    const sandboxPolicy = resolveCliCommandPathPolicy(["sandbox"]);
    expectLoadPluginsResolver(sandboxPolicy);
    expect(sandboxPolicy.pluginRegistry).toEqual({ scope: "sandbox-backends" });

    expect(resolveCliCommandPathPolicy(["sandbox", "explain"]).pluginRegistry).toEqual({
      scope: "sandbox-backends",
    });
    expect(sandboxPolicy.loadPlugins(commandContext(["sandbox", "explain"]))).toBe(true);

    for (const commandPath of [
      ["sandbox", "list"],
      ["sandbox", "recreate"],
    ]) {
      expect(resolveCliCommandPathPolicy(commandPath).pluginRegistry).toEqual({
        scope: "sandbox-management",
      });
    }
  });

  it.each([
    ["list", ["--browser"]],
    ["recreate", ["--browser", "--all"]],
  ])("keeps browser-only sandbox %s independent of plugin activation", (subcommand, flags) => {
    const policy = resolveCliCommandPathPolicy(["sandbox", subcommand]);
    expectLoadPluginsResolver(policy);

    expect(policy.loadPlugins(commandContext(["sandbox", subcommand], flags))).toBe(false);
  });

  it("resolves mixed startup-only rules", () => {
    expectResolvedPolicy(["worker"], {
      configGuard: "skip",
      hideBanner: true,
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(
      ["install", "status", "pair", "setup"].map((action) => `browser extension ${action}`),
      { configGuard: "validate", networkProxy: "bypass" },
    );
    expectResolvedPolicy(["browser extension native-host"], {
      configGuard: "skip",
      ensureCliPath: false,
      hideBanner: true,
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["configure"], {
      configGuard: "skip",
      stateStoreGuard: "run",
    });
    expectResolvedPolicy(["config file"], {
      configGuard: "skip",
      ensureCliPath: false,
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["config set"], {
      configGuard: "defer",
      networkProxy: "bypass",
    });
    const doctorPolicy = resolveCliCommandPathPolicy(["doctor"]);
    expectNetworkProxyResolver(doctorPolicy);
    expect(doctorPolicy).toMatchObject({
      configGuard: "skip",
      loadPlugins: "never",
    });
    expect(doctorPolicy.networkProxy(commandContext(["doctor"]))).toBe("default");
    expect(doctorPolicy.networkProxy(commandContext(["doctor"], ["--state-sqlite=compact"]))).toBe(
      "bypass",
    );
    expect(doctorPolicy.networkProxy(commandContext(["doctor"], ["--client-credentials"]))).toBe(
      "bypass",
    );
    expectResolvedPolicy(["config schema"], {
      configGuard: "skip",
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["plugins update"], { hideBanner: true });
    expectResolvedPolicy(["plugins list"], {
      configGuard: "skip",
      ensureCliPath: false,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(
      ["plugins install", "plugins inspect", "plugins registry", "plugins doctor"],
      {},
    );
    // Authoring commands operate on a target package, not operator config, so
    // a host config the running CLI predates must not abort them.
    expectResolvedPolicy(["plugins build", "plugins validate", "plugins init", "skills search"], {
      configGuard: "skip",
    });
    expectResolvedPolicy(
      [
        "qa suite",
        "config",
        "config validate",
        "gateway status",
        "gateway health",
        "cron list",
        "hooks",
        "hooks list",
        "hooks info",
        "hooks check",
        "skills info",
      ],
      {
        configGuard: "skip",
        networkProxy: "bypass",
      },
    );
    expectResolvedPolicy(["memory index"], {
      configGuard: "validate",
      loadPlugins: "always",
      pluginRegistry: { scope: "memory" },
    });
    expectResolvedPolicy(["memory search"], {
      configGuard: "skip",
      loadPlugins: "always",
      pluginRegistry: { scope: "memory" },
    });
    const memoryStatusPolicy = resolveCliCommandPathPolicy(["memory", "status"]);
    expectConfigGuardResolver(memoryStatusPolicy);
    expect(memoryStatusPolicy.loadPlugins).toBe("always");
    expect(memoryStatusPolicy.pluginRegistry).toEqual({ scope: "memory" });
    expect(memoryStatusPolicy.configGuard(commandContext(["memory", "status"]))).toBe("skip");
    for (const flag of ["--index", "--fix"]) {
      expect(memoryStatusPolicy.configGuard(commandContext(["memory", "status"], [flag]))).toBe(
        "validate",
      );
    }
  });

  it("defaults unknown command paths to network proxy routing", () => {
    expectProxy(["googlemeet", "login"], "default");
    expectProxy(["tool", "image_generate"], "bypass");
    expectProxy(["tools", "effective"], "bypass");
  });

  it("resolves mixed network proxy policies from argv-sensitive catalog entries", () => {
    expectProxy(["gateway"], "default");
    expectProxy(["gateway", "run"], "default");
    expectProxy(["gateway", "health"], "bypass");
    expectProxy(["node", "run"], "default");
    expectProxy(["node", "status"], "bypass");
    expectProxy(["agent", "--local"], "default");
    expectProxy(["agent", "run"], "bypass");
    expectProxy(["chat"], "default");
    expectProxy(["terminal"], "default");
    expectProxy(["tui", "--local"], "default");
    expectProxy(["tui"], "bypass");
    expectProxy(["channels", "status"], "bypass");
    expectProxy(["channels", "status", "--probe"], "default");
    expectProxy(["models", "status"], "bypass");
    expectProxy(["models", "status", "--probe"], "default");
    expectProxy(["models", "--json"], "bypass");
    expectProxy(["models", "--agent", "main", "--status-json"], "bypass");
    expectProxy(["models", "--agent", "main", "auth"], "default");
    expectProxy(["skills", "info", "browser"], "bypass");
    expectProxy(["skills", "check"], "bypass");
    expectProxy(["skills", "list"], "bypass");
    expectProxy(["skills", "search", "browser"], "default");
  });

  it("uses the longest catalog command path for deep network proxy overrides", async () => {
    const catalog: readonly CliCommandCatalogEntry[] = [
      { commandPath: ["nodes"], policy: { networkProxy: "bypass" } },
      {
        commandPath: ["nodes", "camera", "snap"],
        exact: true,
        policy: { networkProxy: "default" },
      },
    ];

    vi.resetModules();
    try {
      vi.doMock("./command-catalog.js", async (importOriginal) => {
        const actual = await importOriginal<typeof import("./command-catalog.js")>();
        return { ...actual, cliCommandCatalog: catalog };
      });
      const { resolveCliNetworkProxyPolicy: resolveCliNetworkProxyPolicyLocal } =
        await importFreshModule<typeof import("./command-path-policy.js")>(
          import.meta.url,
          "./command-path-policy.js?catalog-overrides",
        );

      expect(
        resolveCliNetworkProxyPolicyLocal(["node", "openclaw", "nodes", "camera", "snap"]),
      ).toBe("default");
      expect(
        resolveCliNetworkProxyPolicyLocal(["node", "openclaw", "nodes", "camera", "list"]),
      ).toBe("bypass");
    } finally {
      vi.doUnmock("./command-catalog.js");
      vi.resetModules();
    }
  });

  it("does not let gateway run option values spoof bypass subcommands", () => {
    for (const args of [
      ["gateway", "--token", "status"],
      ["gateway", "--token=status"],
      ["gateway", "--password", "health"],
      ["gateway", "--password-file", "status"],
      ["gateway", "--ws-log", "compact"],
    ]) {
      expectProxy(args, "default");
    }
  });
});
