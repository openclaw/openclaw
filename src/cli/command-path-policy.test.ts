import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { CliCommandCatalogEntry, CliCommandPathPolicy } from "./command-catalog-types.js";
import {
  resolveCliCommandPathPolicy,
  resolveCliNetworkProxyPolicy,
} from "./command-path-policy.js";

const bypass = { networkProxy: "bypass" } as const;
const skip = { ...bypass, configGuard: "skip" } as const;

function expectResolvedPolicy(commands: string, expected: Partial<CliCommandPathPolicy>): void {
  for (const command of commands.split("|")) {
    expect(resolveCliCommandPathPolicy(command.split(" ")), command).toMatchObject(expected);
  }
}

function expectNetworkProxyResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & {
  networkProxy: Exclude<CliCommandPathPolicy["networkProxy"], string>;
} {
  expect(typeof policy.networkProxy).toBe("function");
}

function expectLoadPluginsResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & {
  loadPlugins: Exclude<CliCommandPathPolicy["loadPlugins"], string>;
} {
  expect(typeof policy.loadPlugins).toBe("function");
}

function expectConfigGuardResolver(
  policy: CliCommandPathPolicy,
): asserts policy is CliCommandPathPolicy & {
  configGuard: Exclude<CliCommandPathPolicy["configGuard"], string>;
} {
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
    expect(agentPolicy.pluginRegistry).toEqual({ scope: "all" });
    expectLoadPluginsResolver(agentPolicy);
    expectConfigGuardResolver(agentPolicy);
    expect(agentPolicy.loadPlugins(commandContext(["agent"]))).toBe(false);
    expect(agentPolicy.loadPlugins(commandContext(["agent"], ["--json"], true))).toBe(false);
    expect(agentPolicy.loadPlugins(commandContext(["agent"], ["--local"], true))).toBe(true);
    expect(agentPolicy.configGuard(commandContext(["agent"]))).toBe("skip");
    expect(agentPolicy.configGuard(commandContext(["agent"], ["--local"]))).toBe("run");
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

  it.each<[string, Partial<CliCommandPathPolicy>]>([
    ["browser extension install", { ...bypass, configGuard: "validate" }],
    [
      "browser extension native-host",
      { ...skip, ensureCliPath: false, hideBanner: true, ownsProtocolStdout: true },
    ],
    ["configure", { configGuard: "skip", stateStoreGuard: "run" }],
    ["config file", { ...skip, ensureCliPath: false, ownsProtocolStdout: true }],
    ["plugins update", { hideBanner: true }],
    ["plugins list|plugins lint", { ...skip, ensureCliPath: false }],
    [
      "memory index",
      { configGuard: "validate", loadPlugins: "always", pluginRegistry: { scope: "memory" } },
    ],
    [
      "memory search",
      { configGuard: "skip", loadPlugins: "always", pluginRegistry: { scope: "memory" } },
    ],
  ])("resolves static startup policies for %s", expectResolvedPolicy);

  it("resolves dynamic Doctor and memory startup rules", () => {
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

  it("leaves the gateway auth-token config read to the command", () => {
    expectResolvedPolicy("gateway auth-token", {
      ...skip,
      loadPlugins: "never",
      // Exec SecretRefs resolve through the CLI PATH.
      ensureCliPath: true,
    });
  });

  it("resolves mixed network proxy policies from argv-sensitive catalog entries", () => {
    expectProxy(["gateway"], "default");
    expectProxy(["gateway", "run"], "default");
    expectProxy(["gateway", "health"], "bypass");
    expectProxy(["gateway", "auth-token", "--show"], "bypass");
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
