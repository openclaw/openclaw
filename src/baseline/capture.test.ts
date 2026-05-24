import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries: () => [],
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  listConfiguredChannelIdsForReadOnlyScope: () => ["telegram", "signal"],
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));

import { captureBaseline } from "./capture.js";

describe("captureBaseline", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(
      async ({ method, params }: { method: string; params?: Record<string, unknown> }) => {
        if (method === "status") {
          return { runtimeVersion: "test", eventLoop: { delayMs: 0 } };
        }
        if (method === "sessions.list") {
          return { sessions: [{ id: "session-1" }], totalCount: 3 };
        }
        if (method === "channels.status") {
          return {
            channels: {
              telegram: { configured: true },
              signal: { configured: false },
            },
            channelAccounts: {
              telegram: [{ accountId: "default", running: true }],
              signal: [{ accountId: "default", running: false, connected: false }],
            },
          };
        }
        if (method === "tasks.list") {
          if (params?.cursor === "2") {
            return { tasks: [{ id: "task-3" }] };
          }
          return { tasks: [{ id: "task-1" }, { id: "task-2" }], nextCursor: "2" };
        }
        throw new Error(`unexpected gateway method: ${method}`);
      },
    );
  });

  it("uses supported gateway contracts and applies the requested gateway timeout", async () => {
    const baseline = await captureBaseline({
      gatewayTimeoutMs: 1234,
      skipPlugins: true,
    });

    expect(callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "tasks.flows" }),
    );
    expect(
      callGatewayMock.mock.calls.map(([call]) => ({
        method: call.method,
        timeoutMs: call.timeoutMs,
      })),
    ).toEqual([
      { method: "status", timeoutMs: 1234 },
      { method: "channels.status", timeoutMs: 1234 },
      { method: "tasks.list", timeoutMs: 1234 },
      { method: "tasks.list", timeoutMs: 1234 },
      { method: "sessions.list", timeoutMs: 1234 },
      { method: "tasks.list", timeoutMs: 1234 },
      { method: "tasks.list", timeoutMs: 1234 },
    ]);
    expect(baseline.metrics.sessionCount).toBe(3);
    expect(baseline.metrics.activeTaskCount).toBe(3);
    expect(baseline.components.tasks).toMatchObject({
      status: "pass",
      message: "3 active tasks",
    });
    expect(baseline.components.channels).toMatchObject({
      status: "warn",
      message: "1/2 channels connected",
    });
  });
});
