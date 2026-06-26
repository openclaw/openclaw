import { beforeEach, describe, expect, it, vi } from "vitest";

// These mocks are referenced by hoisted vi.mock factories, so they must be hoisted too.
const { mockClient, forwarderClose, prepareNodeAttachMock } = vi.hoisted(() => {
  const forwarderCloseFn = vi.fn(async () => {});
  return {
    mockClient: { request: vi.fn(async () => ({})), close: vi.fn() },
    forwarderClose: forwarderCloseFn,
    prepareNodeAttachMock: vi.fn(async () => ({
      sessionKey: "agent:main:node",
      cliSessionId: "sid",
      forwarder: { close: forwarderCloseFn },
      mcpConfig: { mcpServers: { openclaw: {} } },
      env: { OPENCLAW_MCP_TOKEN: "node-token" },
      launchArgs: ["--resume", "sid"],
      transcriptPath: "/tmp/sid.jsonl",
    })),
  };
});

vi.mock("../../node-host/config.js", () => ({ loadNodeHostConfig: vi.fn() }));
vi.mock("../../node-host/runner.js", () => ({
  resolveNodeHostGatewayCredentials: vi.fn(async () => ({ token: "node-token" })),
}));
vi.mock("../../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: vi.fn(() => ({})),
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../gateway/client.js", () => ({
  // Regular function (not an arrow) so `new GatewayClient(...)` is constructable; returns the mock.
  GatewayClient: vi.fn(function GatewayClientMock() {
    return mockClient;
  }),
}));
vi.mock("../../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({ ready: true })),
}));
vi.mock("../../node-host/attach.js", () => ({ prepareNodeAttach: prepareNodeAttachMock }));

import { loadNodeHostConfig } from "../../node-host/config.js";
import { runNodeAttach } from "./attach.js";

describe("runNodeAttach (node conduit launcher)", () => {
  beforeEach(() => {
    mockClient.request.mockClear().mockResolvedValue({});
    mockClient.close.mockClear();
    forwarderClose.mockClear();
    prepareNodeAttachMock.mockClear();
  });

  it("throws when there is no node-host config (not run on a paired node)", async () => {
    vi.mocked(loadNodeHostConfig).mockResolvedValueOnce(null as never);
    await expect(runNodeAttach({ cwd: "/work", nowMs: 0 })).rejects.toThrow(/node-host config/);
    expect(prepareNodeAttachMock).not.toHaveBeenCalled();
  });

  it("connects, runs prepareNodeAttach, returns the plan, and close() tears down forwarder + link", async () => {
    vi.mocked(loadNodeHostConfig).mockResolvedValueOnce({ nodeId: "node-1", gateway: {} } as never);
    const plan = await runNodeAttach({ cwd: "/work", nowMs: 1_000 });
    expect(plan.sessionKey).toBe("agent:main:node");
    expect(plan.launchArgs).toEqual(["--resume", "sid"]);
    expect(plan.env.OPENCLAW_MCP_TOKEN).toBe("node-token");
    expect(prepareNodeAttachMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: mockClient, cwd: "/work", nowMs: 1_000 }),
    );
    await plan.close();
    // close() revokes the node-minted grant (symmetry with the gateway-host path), then tears down
    expect(mockClient.request).toHaveBeenCalledWith("node.attachRevoke", {
      grantToken: "node-token",
    });
    expect(forwarderClose).toHaveBeenCalledTimes(1);
    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  it("fails fast and surfaces the real error on a non-transient connectivity failure", async () => {
    vi.mocked(loadNodeHostConfig).mockResolvedValueOnce({ nodeId: "node-1", gateway: {} } as never);
    mockClient.request.mockRejectedValueOnce(new Error("missing scope: node")); // not "not connected"
    await expect(runNodeAttach({ cwd: "/work", nowMs: 0 })).rejects.toThrow(/missing scope: node/);
    // did not spin the full retry loop, and never reached the orchestration
    expect(mockClient.request).toHaveBeenCalledTimes(1);
    expect(prepareNodeAttachMock).not.toHaveBeenCalled();
  });
});
