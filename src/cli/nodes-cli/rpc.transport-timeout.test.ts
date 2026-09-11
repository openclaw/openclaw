import { beforeEach, describe, expect, it, vi } from "vitest";
import { callNodesGatewayCli, callNodePairApprovalGatewayCli } from "./rpc.js";

const { callGatewaySpy } = vi.hoisted(() => ({
  callGatewaySpy: vi.fn<(opts: Record<string, unknown>) => Promise<{ decision: "allow-once" }>>(
    async () => ({ decision: "allow-once" }),
  ),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewaySpy,
  randomIdempotencyKey: () => "mock-key",
}));

vi.mock("../progress.js", () => ({
  withProgress: (_opts: unknown, fn: () => unknown) => fn(),
}));

function firstGatewayCall(): Record<string, unknown> {
  const [callOpts] = callGatewaySpy.mock.calls[0] ?? [];
  if (!callOpts) {
    throw new Error("expected gateway call");
  }
  return callOpts;
}

describe("node RPC transport timeouts", () => {
  beforeEach(() => {
    callGatewaySpy.mockClear();
    callGatewaySpy.mockResolvedValue({ decision: "allow-once" });
  });

  it("callNodesGatewayCli forwards opts.timeout as the transport timeoutMs", async () => {
    await callNodesGatewayCli(
      "exec.approval.request",
      { timeout: "35000" },
      {
        timeoutMs: 120_000,
      },
    );

    expect(callGatewaySpy).toHaveBeenCalledTimes(1);
    const callOpts = firstGatewayCall();
    expect(callOpts.method).toBe("exec.approval.request");
    expect(callOpts.timeoutMs).toBe(35_000);
  });

  it("callNodesGatewayCli rejects invalid opts.timeout instead of forwarding NaN", async () => {
    await expect(
      callNodesGatewayCli(
        "exec.approval.request",
        { timeout: "nope" },
        {
          timeoutMs: 120_000,
        },
      ),
    ).rejects.toThrow("Invalid --timeout");

    expect(callGatewaySpy).not.toHaveBeenCalled();
  });

  it("callNodePairApprovalGatewayCli rejects invalid opts.timeout instead of forwarding NaN", async () => {
    await expect(
      callNodePairApprovalGatewayCli("node.pair.list", { timeout: "Infinity" }, {}, { scopes: [] }),
    ).rejects.toThrow("Invalid --timeout");

    expect(callGatewaySpy).not.toHaveBeenCalled();
  });
});
