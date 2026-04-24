import { beforeEach, describe, expect, it, vi } from "vitest";
import { READ_SCOPE } from "./method-scopes.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { fetchToolsCatalog } from "./tools-catalog-helper.js";

const { callGatewayScopedMock } = vi.hoisted(() => ({
  callGatewayScopedMock: vi.fn(),
}));
const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({
    gateway: {
      mode: "local",
      port: 19001,
      tls: { enabled: false },
      auth: { mode: "none" },
    },
  })),
}));

vi.mock("./call.js", () => ({
  callGatewayScoped: callGatewayScopedMock,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

describe("fetchToolsCatalog", () => {
  beforeEach(() => {
    callGatewayScopedMock.mockReset();
  });

  it("calls tools.catalog with protocol version 3 and operator.read scope", async () => {
    const catalog = {
      agentId: "main",
      profiles: [
        { id: "minimal", label: "Minimal" },
        { id: "coding", label: "Coding" },
      ],
      groups: [
        {
          id: "core:automation",
          label: "Automation",
          source: "core",
          tools: [
            {
              id: "cron.list",
              label: "List cron jobs",
              description: "Read-only cron list",
              source: "core",
              defaultProfiles: ["minimal"],
            },
          ],
        },
      ],
    } as const;

    callGatewayScopedMock.mockResolvedValue(catalog);

    await expect(
      fetchToolsCatalog({
        agentId: " main ",
        includePlugins: false,
        url: "ws://127.0.0.1:18789/",
        timeoutMs: 8_000,
      }),
    ).resolves.toEqual(catalog);

    expect(callGatewayScopedMock).toHaveBeenCalledWith({
      method: "tools.catalog",
      params: {
        agentId: "main",
        includePlugins: false,
      },
      scopes: [READ_SCOPE],
      config: {
        gateway: {
          mode: "local",
          port: 18789,
          tls: { enabled: false },
          auth: { mode: "none" },
        },
      },
      url: undefined,
      timeoutMs: 8_000,
      token: undefined,
      password: undefined,
      configPath: undefined,
      clientName: "cli",
      clientDisplayName: "Jarvis Desktop",
      clientVersion: "dev",
      platform: process.platform,
      mode: "cli",
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
    });
  });

  it("omits empty params and returns the raw ToolsCatalogResult shape", async () => {
    const catalog = {
      agentId: "default",
      profiles: [{ id: "full", label: "Full" }],
      groups: [],
    };

    callGatewayScopedMock.mockResolvedValue(catalog);

    await expect(fetchToolsCatalog()).resolves.toEqual(catalog);

    expect(callGatewayScopedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tools.catalog",
        params: undefined,
        scopes: [READ_SCOPE],
        config: {
          gateway: {
            mode: "local",
            port: 19001,
            tls: { enabled: false },
            auth: { mode: "none" },
          },
        },
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      }),
    );
  });

  it("propagates auth failures from the gateway client path", async () => {
    const authError = new Error("gateway closed (4401): missing operator.read");
    callGatewayScopedMock.mockRejectedValue(authError);

    await expect(
      fetchToolsCatalog({
        token: "secret-token",
      }),
    ).rejects.toThrow("missing operator.read");
  });

  it("propagates degraded gateway failures without rewriting them", async () => {
    const gatewayError = new Error("gateway timeout after 10000ms");
    callGatewayScopedMock.mockRejectedValue(gatewayError);

    await expect(
      fetchToolsCatalog({
        includePlugins: true,
      }),
    ).rejects.toThrow("gateway timeout");
  });
});
