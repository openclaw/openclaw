import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveRuntimePluginRegistryMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();
const getActiveSecretsRuntimeSnapshotMock = vi.fn();

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: (params: unknown) => resolveRuntimePluginRegistryMock(params),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: unknown) => applyPluginAutoEnableMock(params),
}));

vi.mock("../secrets/runtime.js", () => ({
  getActiveSecretsRuntimeSnapshot: () => getActiveSecretsRuntimeSnapshotMock(),
}));

let resolvePluginMcpServers: typeof import("./mcp-servers.js").resolvePluginMcpServers;

describe("resolvePluginMcpServers", () => {
  beforeEach(async () => {
    vi.resetModules();
    resolveRuntimePluginRegistryMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation(({ config }: { config: unknown }) => ({
      config,
      changes: [],
    }));
    getActiveSecretsRuntimeSnapshotMock.mockReset();
    ({ resolvePluginMcpServers } = await import("./mcp-servers.js"));
  });

  it("resolves plugin MCP server registrations with OpenClaw metadata", () => {
    getActiveSecretsRuntimeSnapshotMock.mockReturnValue({
      config: {
        channels: {
          ando: {
            apiKey: "runtime-key",
          },
        },
      },
    });
    resolveRuntimePluginRegistryMock.mockReturnValue({
      mcpServers: [
        {
          pluginId: "ando",
          pluginName: "Ando",
          serverName: "ando",
          source: "/tmp/ando.js",
          factory: (context: { runtimeConfig?: unknown }) => ({
            url: "https://mcp.example/mcp",
            transport: "streamable-http",
            headers: {
              Authorization: `Bearer ${
                (context.runtimeConfig as { channels?: { ando?: { apiKey?: string } } })?.channels
                  ?.ando?.apiKey
              }`,
            },
          }),
          options: {
            toolNamePrefix: "ando_",
            allowTools: ["send_message"],
            denyTools: ["set_agent_subscription"],
            toolOverrides: {
              send_message: {
                description: "Send an Ando message",
              },
            },
          },
        },
      ],
    });

    const result = resolvePluginMcpServers({
      workspaceDir: "/workspace",
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.mcpServers).toEqual({
      ando: {
        url: "https://mcp.example/mcp",
        transport: "streamable-http",
        headers: {
          Authorization: "Bearer runtime-key",
        },
        openclaw: {
          toolNamePrefix: "ando_",
          allowTools: ["send_message"],
          denyTools: ["set_agent_subscription"],
          toolOverrides: {
            send_message: {
              description: "Send an Ando message",
            },
          },
        },
      },
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace",
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            enabled: true,
          }),
        }),
      }),
    );
  });

  it("skips plugin loading when plugins are disabled", () => {
    const result = resolvePluginMcpServers({
      config: {
        plugins: {
          enabled: false,
        },
      },
    });

    expect(result).toEqual({ mcpServers: {}, diagnostics: [] });
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("reports plugin MCP factory failures as diagnostics", () => {
    resolveRuntimePluginRegistryMock.mockReturnValue({
      mcpServers: [
        {
          pluginId: "broken",
          pluginName: "Broken",
          serverName: "broken",
          source: "/tmp/broken.js",
          factory: () => {
            throw new Error("no token");
          },
        },
      ],
    });

    const result = resolvePluginMcpServers({
      config: {
        plugins: {
          enabled: true,
        },
      },
    });

    expect(result.mcpServers).toEqual({});
    expect(result.diagnostics).toEqual([
      {
        pluginId: "broken",
        message: 'plugin MCP server "broken" failed: no token',
      },
    ]);
  });
});
