// Command path policy tests cover allowed CLI command path shapes and lazy imports.
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

function expectResolvedPolicy(
  commandPath: string[],
  expected: Partial<CliCommandPathPolicy>,
): void {
  expect(resolveCliCommandPathPolicy(commandPath)).toEqual({
    ...DEFAULT_EXPECTED_POLICY,
    ...expected,
  });
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
    expect(
      agentPolicy.loadPlugins({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      agentPolicy.loadPlugins({
        argv: ["node", "openclaw", "agent", "--json"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      agentPolicy.loadPlugins({
        argv: ["node", "openclaw", "agent", "--local"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }),
    ).toBe(true);
    expect(
      agentPolicy.configGuard({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
      }),
    ).toBe("skip");
    expect(
      agentPolicy.configGuard({
        argv: ["node", "openclaw", "agent", "--local"],
        commandPath: ["agent"],
      }),
    ).toBe("run");
    expectResolvedPolicy(["agent", "exec"], {
      configGuard: "skip",
      ownsProtocolStdout: true,
      hideBanner: true,
    });

    for (const commandPath of [["agents"], ["agents", "list"]]) {
      expectResolvedPolicy(commandPath, {
        configGuard: "skip",
        networkProxy: "bypass",
      });
    }
    for (const commandPath of [
      ["agents", "add"],
      ["agents", "team", "create"],
    ]) {
      expectResolvedPolicy(commandPath, { configGuard: "defer", networkProxy: "bypass" });
    }
    for (const commandPath of [
      ["agents", "bind"],
      ["agents", "unbind"],
      ["agents", "set-identity"],
      ["agents", "delete"],
    ]) {
      expectResolvedPolicy(commandPath, { networkProxy: "bypass" });
    }
    expectResolvedPolicy(["agents", "bindings"], {
      configGuard: "skip",
      networkProxy: "bypass",
    });
  });

  it("loads only sandbox backend owner plugins for runtime commands", () => {
    const sandboxPolicy = resolveCliCommandPathPolicy(["sandbox"]);
    expectLoadPluginsResolver(sandboxPolicy);
    expect(sandboxPolicy.pluginRegistry).toEqual({ scope: "sandbox-backends" });

    for (const commandPath of [["sandbox", "explain"]]) {
      expect(resolveCliCommandPathPolicy(commandPath).pluginRegistry).toEqual({
        scope: "sandbox-backends",
      });
      expect(
        sandboxPolicy.loadPlugins({
          argv: ["node", "openclaw", ...commandPath],
          commandPath,
          jsonOutputMode: false,
        }),
      ).toBe(true);
    }

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

    expect(
      policy.loadPlugins({
        argv: ["node", "openclaw", "sandbox", subcommand, ...flags],
        commandPath: ["sandbox", subcommand],
        jsonOutputMode: false,
      }),
    ).toBe(false);
  });

  it("resolves mixed startup-only rules", () => {
    expectResolvedPolicy(["qa", "suite"], {
      configGuard: "skip",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["worker"], {
      configGuard: "skip",
      hideBanner: true,
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    for (const action of ["install", "status", "pair", "setup"]) {
      expectResolvedPolicy(["browser", "extension", action], {
        configGuard: "validate",
        networkProxy: "bypass",
      });
    }
    expectResolvedPolicy(["browser", "extension", "native-host"], {
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
    expectResolvedPolicy(["config"], {
      configGuard: "skip",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["config", "file"], {
      configGuard: "skip",
      ensureCliPath: false,
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["config", "set"], {
      configGuard: "defer",
      networkProxy: "bypass",
    });
    const doctorPolicy = resolveCliCommandPathPolicy(["doctor"]);
    expectNetworkProxyResolver(doctorPolicy);
    expect(doctorPolicy).toMatchObject({
      configGuard: "skip",
      loadPlugins: "never",
    });
    expect(
      doctorPolicy.networkProxy({
        argv: ["node", "openclaw", "doctor"],
        commandPath: ["doctor"],
      }),
    ).toBe("default");
    expect(
      doctorPolicy.networkProxy({
        argv: ["node", "openclaw", "doctor", "--state-sqlite=compact"],
        commandPath: ["doctor"],
      }),
    ).toBe("bypass");
    expectResolvedPolicy(["config", "validate"], {
      configGuard: "skip",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["config", "schema"], {
      configGuard: "skip",
      ownsProtocolStdout: true,
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["gateway", "status"], {
      configGuard: "skip",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["gateway", "health"], {
      configGuard: "skip",
      networkProxy: "bypass",
    });
    expectResolvedPolicy(["plugins", "update"], { hideBanner: true });
    expectResolvedPolicy(["plugins", "list"], {
      configGuard: "skip",
      ensureCliPath: false,
      networkProxy: "bypass",
    });
    for (const commandPath of [
      ["plugins", "install"],
      ["plugins", "inspect"],
      ["plugins", "registry"],
      ["plugins", "doctor"],
    ]) {
      expectResolvedPolicy(commandPath, {});
    }
    // Authoring commands operate on a target package, not operator config, so
    // a host config the running CLI predates must not abort them.
    for (const commandPath of [
      ["plugins", "build"],
      ["plugins", "validate"],
      ["plugins", "init"],
    ]) {
      expectResolvedPolicy(commandPath, {
        configGuard: "skip",
      });
    }
    expectResolvedPolicy(["cron", "list"], {
      configGuard: "skip",
      networkProxy: "bypass",
    });
    for (const commandPath of [
      ["hooks"],
      ["hooks", "list"],
      ["hooks", "info"],
      ["hooks", "check"],
      ["skills", "info"],
    ]) {
      expectResolvedPolicy(commandPath, {
        configGuard: "skip",
        networkProxy: "bypass",
      });
    }
    expectResolvedPolicy(["skills", "search"], {
      configGuard: "skip",
    });
    expectResolvedPolicy(["memory", "search"], {
      configGuard: "skip",
      loadPlugins: "always",
      pluginRegistry: { scope: "memory" },
    });
    const memoryStatusPolicy = resolveCliCommandPathPolicy(["memory", "status"]);
    expectConfigGuardResolver(memoryStatusPolicy);
    expect(memoryStatusPolicy.loadPlugins).toBe("always");
    expect(memoryStatusPolicy.pluginRegistry).toEqual({ scope: "memory" });
    expect(
      memoryStatusPolicy.configGuard({
        argv: ["node", "openclaw", "memory", "status"],
        commandPath: ["memory", "status"],
      }),
    ).toBe("skip");
    for (const flag of ["--index", "--fix"]) {
      expect(
        memoryStatusPolicy.configGuard({
          argv: ["node", "openclaw", "memory", "status", flag],
          commandPath: ["memory", "status"],
        }),
      ).toBe("run");
    }
  });

  it("defaults unknown command paths to network proxy routing", () => {
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "googlemeet", "login"])).toBe(
      "default",
    );
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "tool", "image_generate"])).toBe(
      "bypass",
    );
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "tools", "effective"])).toBe("bypass");
  });

  it("resolves mixed network proxy policies from argv-sensitive catalog entries", () => {
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "gateway"])).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "gateway", "run"])).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "gateway", "health"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "node", "run"])).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "node", "status"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "agent", "--local"])).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "agent", "run"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "channels", "status"])).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "channels", "status", "--probe"]),
    ).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "models", "status"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "models", "status", "--probe"])).toBe(
      "default",
    );
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "models", "--json"])).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy([
        "node",
        "openclaw",
        "models",
        "--agent",
        "main",
        "--status-json",
      ]),
    ).toBe("bypass");
    expect(
      resolveCliNetworkProxyPolicy(["node", "openclaw", "models", "--agent", "main", "auth"]),
    ).toBe("default");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "info", "browser"])).toBe(
      "bypass",
    );
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "check"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "list"])).toBe("bypass");
    expect(resolveCliNetworkProxyPolicy(["node", "openclaw", "skills", "search", "browser"])).toBe(
      "default",
    );
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
    for (const argv of [
      ["node", "openclaw", "gateway", "--token", "status"],
      ["node", "openclaw", "gateway", "--token=status"],
      ["node", "openclaw", "gateway", "--password", "health"],
      ["node", "openclaw", "gateway", "--password-file", "status"],
      ["node", "openclaw", "gateway", "--ws-log", "compact"],
    ]) {
      expect(resolveCliNetworkProxyPolicy(argv), argv.join(" ")).toBe("default");
    }
  });
});
