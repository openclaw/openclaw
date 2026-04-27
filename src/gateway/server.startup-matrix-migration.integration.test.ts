import { beforeEach, describe, expect, it, vi } from "vitest";

const runChannelPluginStartupMaintenanceMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: (params: unknown) =>
    runChannelPluginStartupMaintenanceMock(params),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/subagent-registry.js", () => ({
  initSubagentRegistry: vi.fn(),
}));

describe("gateway startup channel maintenance wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    runChannelPluginStartupMaintenanceMock.mockClear();
  });

  it("runs startup channel maintenance with the resolved startup config", async () => {
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {
        plugins: { enabled: true },
      },
      startupRuntimeConfig: {
        plugins: { enabled: true },
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      },
      minimalTestGateway: true,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

    expect(runChannelPluginStartupMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(runChannelPluginStartupMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            matrix: expect.objectContaining({
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            }),
          }),
        }),
        env: process.env,
        log: expect.anything(),
      }),
    );
  });
});
