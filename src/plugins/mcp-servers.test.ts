import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadEnabledPluginMcpServerConfig,
  normalizePluginRegisteredMcpServerConfig,
} from "./mcp-servers.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

beforeEach(() => {
  resetPluginRuntimeStateForTest();
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("loadEnabledPluginMcpServerConfig", () => {
  it("returns an empty config when there is no active registry", () => {
    expect(loadEnabledPluginMcpServerConfig()).toEqual({
      config: {
        mcpServers: {},
      },
    });
  });

  it("includes loaded plugin MCP servers with deterministic order and default cwd", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "plugin-a",
        rootDir: "/tmp/plugin-a",
      }),
    );
    registry.plugins.push(
      createPluginRecord({
        id: "plugin-b-disabled",
        rootDir: "/tmp/plugin-b",
        enabled: false,
      }),
    );
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "zServer",
      server: { command: "node", args: ["z.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    registry.mcpServers.push({
      pluginId: "plugin-b-disabled",
      name: "aServer",
      server: { command: "node", args: ["a.mjs"] },
      source: "/tmp/plugin-b/index.cjs",
      rootDir: "/tmp/plugin-b",
    });
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "bServer",
      server: { command: "node", args: ["b.mjs"], cwd: "/custom-cwd" },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    const loaded = loadEnabledPluginMcpServerConfig({
      workspaceDir: "/tmp/workspace-a",
    });

    expect(Object.keys(loaded.config.mcpServers)).toEqual(["bServer", "zServer"]);
    expect(loaded.config.mcpServers.bServer).toEqual({
      command: "node",
      args: ["b.mjs"],
      cwd: "/custom-cwd",
    });
    expect(loaded.config.mcpServers.zServer).toEqual({
      command: "node",
      args: ["z.mjs"],
      cwd: "/tmp/plugin-a",
    });
  });

  it("ignores active registries from a different workspace", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "plugin-a", rootDir: "/tmp/plugin-a" }));
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(loadEnabledPluginMcpServerConfig({ workspaceDir: "/tmp/workspace-b" })).toEqual({
      config: {
        mcpServers: {},
      },
    });
  });

  it("fails closed when the active registry has no workspace binding", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "plugin-a", rootDir: "/tmp/plugin-a" }));
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test");

    expect(loadEnabledPluginMcpServerConfig({ workspaceDir: "/tmp/workspace-a" })).toEqual({
      config: {
        mcpServers: {},
      },
    });
  });

  it("uses an explicit registry even when the active workspace does not match", () => {
    const explicitRegistry = createEmptyPluginRegistry();
    explicitRegistry.plugins.push(createPluginRecord({ id: "plugin-a", rootDir: "/tmp/plugin-a" }));
    explicitRegistry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });

    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.plugins.push(createPluginRecord({ id: "plugin-b", rootDir: "/tmp/plugin-b" }));
    setActivePluginRegistry(activeRegistry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        registry: explicitRegistry,
        workspaceDir: "/tmp/workspace-b",
      }),
    ).toEqual({
      config: {
        mcpServers: {
          helloWorld: {
            command: "node",
            args: ["hello.mjs"],
            cwd: "/tmp/plugin-a",
          },
        },
      },
    });
  });

  it("treats an explicit null registry as no registry", () => {
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.plugins.push(createPluginRecord({ id: "plugin-a", rootDir: "/tmp/plugin-a" }));
    activeRegistry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(activeRegistry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        registry: null,
        workspaceDir: "/tmp/workspace-a",
      }),
    ).toEqual({
      config: {
        mcpServers: {},
      },
    });
  });

  it("honors plugins.entries.<id>.enabled=false from runtime config", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "plugin-a", rootDir: "/tmp/plugin-a" }));
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {
          plugins: {
            entries: {
              "plugin-a": {
                enabled: false,
              },
            },
          },
        },
      }),
    ).toEqual({
      config: {
        mcpServers: {},
      },
    });
  });

  it("drops workspace plugin MCP servers after an allowlist is cleared", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "plugin-a",
        rootDir: "/tmp/plugin-a",
        origin: "workspace",
        activationSource: "explicit",
      }),
    );
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {
          plugins: {},
        },
      }),
    ).toEqual({
      config: {
        mcpServers: {},
      },
    });
  });

  it("drops workspace plugin MCP servers when the plugins block is removed", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "plugin-a",
        rootDir: "/tmp/plugin-a",
        origin: "workspace",
        activationSource: "explicit",
      }),
    );
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {},
      }),
    ).toEqual({
      config: {
        mcpServers: {},
      },
    });
  });

  it("keeps bundled default-enabled MCP servers when runtime config has no allowlist", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "plugin-a",
        rootDir: "/tmp/plugin-a",
        origin: "bundled",
        enabledByDefault: true,
        activationSource: "default",
      }),
    );
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {
          plugins: {},
        },
      }),
    ).toEqual({
      config: {
        mcpServers: {
          helloWorld: {
            command: "node",
            args: ["hello.mjs"],
            cwd: "/tmp/plugin-a",
          },
        },
      },
    });
  });

  it("keeps bundled default-enabled MCP servers after explicit enablement is removed", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "plugin-a",
        rootDir: "/tmp/plugin-a",
        origin: "bundled",
        enabledByDefault: true,
        activationSource: "explicit",
      }),
    );
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {},
      }),
    ).toEqual({
      config: {
        mcpServers: {
          helloWorld: {
            command: "node",
            args: ["hello.mjs"],
            cwd: "/tmp/plugin-a",
          },
        },
      },
    });
  });

  it("honors plugins.allow allowlists from runtime config", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "plugin-a", rootDir: "/tmp/plugin-a" }));
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {
          plugins: {
            allow: ["plugin-b"],
          },
        },
      }),
    ).toEqual({
      config: {
        mcpServers: {},
      },
    });

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {
          plugins: {
            allow: ["plugin-a"],
          },
        },
      }),
    ).toEqual({
      config: {
        mcpServers: {
          helloWorld: {
            command: "node",
            args: ["hello.mjs"],
            cwd: "/tmp/plugin-a",
          },
        },
      },
    });
  });

  it("honors plugins.deny and plugins.enabled=false from runtime config", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "plugin-a", rootDir: "/tmp/plugin-a" }));
    registry.mcpServers.push({
      pluginId: "plugin-a",
      name: "helloWorld",
      server: { command: "node", args: ["hello.mjs"] },
      source: "/tmp/plugin-a/index.cjs",
      rootDir: "/tmp/plugin-a",
    });
    setActivePluginRegistry(registry, "mcp-server-test", "default", "/tmp/workspace-a");

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {
          plugins: {
            deny: ["plugin-a"],
          },
        },
      }),
    ).toEqual({
      config: {
        mcpServers: {},
      },
    });

    expect(
      loadEnabledPluginMcpServerConfig({
        workspaceDir: "/tmp/workspace-a",
        cfg: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toEqual({
      config: {
        mcpServers: {},
      },
    });
  });

  it("normalizes plugin MCP registrations to managed stdio config", () => {
    expect(
      normalizePluginRegisteredMcpServerConfig({
        name: "helloWorld",
        server: { command: " node ", args: ["hello.mjs"], transport: "stdio" },
        rootDir: "/tmp/plugin-a",
      }),
    ).toEqual({
      ok: true,
      server: {
        command: "node",
        args: ["hello.mjs"],
        transport: "stdio",
        cwd: "/tmp/plugin-a",
      },
    });
  });

  it("rejects plugin MCP registrations without a managed stdio command", () => {
    expect(
      normalizePluginRegisteredMcpServerConfig({
        name: "helloWorld",
        server: { url: "http://127.0.0.1:8787/mcp" },
      }),
    ).toEqual({
      ok: false,
      error: 'MCP server "helloWorld" must use managed stdio transport, not URL transport',
    });
    expect(
      normalizePluginRegisteredMcpServerConfig({
        name: "helloWorld",
        server: { transport: "sse", command: "node" },
      }),
    ).toEqual({
      ok: false,
      error: 'MCP server "helloWorld" must use stdio transport (received sse)',
    });
  });
});
