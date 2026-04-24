import { beforeEach, describe, expect, it, vi } from "vitest";
import { READ_SCOPE } from "./method-scopes.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { fetchHomeDashboard } from "./home-dashboard-helper.js";

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

describe("fetchHomeDashboard", () => {
  beforeEach(() => {
    callGatewayScopedMock.mockReset();
  });

  it("builds a combined OpenClaw-native home dashboard snapshot", async () => {
    callGatewayScopedMock.mockImplementation(async ({ method }) => {
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "sessions.json",
          count: 1,
          defaults: {
            modelProvider: "openai",
            model: "gpt-5",
            contextTokens: 128000,
          },
          sessions: [
            {
              key: "agent:jarvis-desktop:main",
              kind: "direct",
              derivedTitle: "Daily planning",
              channel: "internal",
              updatedAt: 1_717_113_600_000,
              lastMessagePreview: "Summarize today and blockers",
            },
          ],
        };
      }

      if (method === "cron.list") {
        return {
          jobs: [
            {
              id: "cron-1",
              name: "Morning sync",
              enabled: true,
              updatedAtMs: 1_717_113_200_000,
              schedule: { kind: "cron", expr: "0 9 * * *" },
              state: { nextRunAtMs: 1_717_117_200_000 },
            },
          ],
          total: 1,
          offset: 0,
          limit: 6,
          hasMore: false,
          nextOffset: null,
        };
      }

      if (method === "tools.catalog") {
        return {
          agentId: "jarvis-desktop",
          profiles: [{ id: "minimal", label: "Minimal" }],
          groups: [
            {
              id: "core:memory",
              label: "Memory",
              source: "core",
              tools: [
                {
                  id: "memory_search",
                  label: "Memory search",
                  description: "Search indexed memory",
                  source: "core",
                  defaultProfiles: ["minimal"],
                },
                {
                  id: "random_tool",
                  label: "Ignore me",
                  description: "Not curated",
                  source: "core",
                  defaultProfiles: [],
                },
              ],
            },
          ],
        };
      }

      throw new Error(`Unexpected method ${method}`);
    });

    await expect(
      fetchHomeDashboard({
        agentId: " jarvis-desktop ",
        url: "ws://127.0.0.1:18789/",
        timeoutMs: 8_000,
      }),
    ).resolves.toEqual({
      agentId: "jarvis-desktop",
      gatewayUrl: "ws://127.0.0.1:18789/",
      source: "openclaw-home-dashboard",
      activity: {
        status: "ready",
        warning: null,
        items: [
          {
            id: "agent:jarvis-desktop:main",
            label: "Daily planning",
            kind: "direct",
            channel: "internal",
            updatedAt: "2024-05-31T00:00:00.000Z",
            lastMessagePreview: "Summarize today and blockers",
          },
        ],
      },
      scheduled: {
        status: "ready",
        warning: null,
        items: [
          {
            id: "cron-1",
            name: "Morning sync",
            mode: "cron",
            enabled: true,
            nextRunAt: "2024-05-31T01:00:00.000Z",
            updatedAt: "2024-05-30T23:53:20.000Z",
          },
        ],
      },
      suggestedTools: {
        status: "ready",
        warning: null,
        items: [
          {
            id: "memory_search",
            label: "Memory search",
            description: "Search indexed memory",
            source: "core",
            pluginId: null,
            defaultProfiles: ["minimal"],
          },
        ],
      },
    });

    expect(callGatewayScopedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.list",
        params: {
          agentId: "jarvis-desktop",
          limit: 6,
          includeDerivedTitles: true,
          includeLastMessage: true,
        },
        scopes: [READ_SCOPE],
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      }),
    );
    expect(callGatewayScopedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.list",
        params: {
          enabled: "enabled",
          limit: 6,
          sortBy: "nextRunAtMs",
          sortDir: "asc",
        },
      }),
    );
    expect(callGatewayScopedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tools.catalog",
        params: {
          agentId: "jarvis-desktop",
          includePlugins: true,
        },
      }),
    );
  });

  it("marks only the affected section unavailable on non-fatal upstream failures", async () => {
    callGatewayScopedMock.mockImplementation(async ({ method }) => {
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "sessions.json",
          count: 0,
          defaults: {
            modelProvider: "openai",
            model: "gpt-5",
            contextTokens: 128000,
          },
          sessions: [],
        };
      }

      if (method === "cron.list") {
        throw new Error("cron.list returned a malformed gateway health check payload");
      }

      return {
        agentId: "jarvis-desktop",
        profiles: [],
        groups: [],
      };
    });

    await expect(fetchHomeDashboard()).resolves.toMatchObject({
      activity: {
        status: "empty",
        warning: null,
        items: [],
      },
      scheduled: {
        status: "unavailable",
        warning: "cron.list returned a malformed gateway health check payload",
        items: [],
      },
      suggestedTools: {
        status: "empty",
        warning: null,
        items: [],
      },
    });
  });

  it("propagates fatal gateway failures for a full-page degraded state", async () => {
    callGatewayScopedMock.mockRejectedValue(
      Object.assign(new Error("connect ETIMEDOUT 127.0.0.1:18789"), {
        code: "gateway_unavailable",
      }),
    );

    await expect(fetchHomeDashboard()).rejects.toThrow("ETIMEDOUT");
  });
});
