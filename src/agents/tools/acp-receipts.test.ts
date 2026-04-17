import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  resolveSessionToolContextMock: vi.fn(() => ({
    cfg: {} as never,
    mainKey: "main",
    alias: "main",
    requesterInternalKey: "agent:main:parent",
    effectiveRequesterKey: "agent:main:parent",
    restrictToSpawned: false,
  })),
  createAgentToAgentPolicyMock: vi.fn(() => ({
    enabled: false,
    matchesAllow: () => false,
    isAllowed: (r: string, t: string) => r === t,
  })),
  resolveEffectiveSessionToolsVisibilityMock: vi.fn(() => "all"),
  createSessionVisibilityGuardMock: vi.fn(async () => ({
    check: () => ({ allowed: true }),
  })),
  resolveSessionReferenceMock: vi.fn(async () => ({
    ok: true,
    key: "agent:main:parent",
    displayKey: "agent:main:parent",
    status: "ok",
  })),
  resolveVisibleSessionReferenceMock: vi.fn(async () => ({
    ok: true,
    key: "agent:main:parent",
    displayKey: "agent:main:parent",
  })),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    resolveSessionToolContext: () => hoisted.resolveSessionToolContextMock(),
    createAgentToAgentPolicy: () => hoisted.createAgentToAgentPolicyMock(),
    resolveEffectiveSessionToolsVisibility: () =>
      hoisted.resolveEffectiveSessionToolsVisibilityMock(),
    createSessionVisibilityGuard: async () => await hoisted.createSessionVisibilityGuardMock(),
    resolveSessionReference: async () => await hoisted.resolveSessionReferenceMock(),
    resolveVisibleSessionReference: async () => await hoisted.resolveVisibleSessionReferenceMock(),
  };
});

describe("acp_receipts tool", () => {
  let createAcpReceiptsTool: typeof import("./acp-receipts-tool.js").createAcpReceiptsTool;
  let recordReceipt: typeof import("../../infra/outbound/delivery-receipts.js").recordReceipt;
  let resetDeliveryReceiptsForTest: typeof import("../../infra/outbound/delivery-receipts.js").resetDeliveryReceiptsForTest;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ createAcpReceiptsTool } = await import("./acp-receipts-tool.js"));
    ({ recordReceipt, resetDeliveryReceiptsForTest } =
      await import("../../infra/outbound/delivery-receipts.js"));
    resetDeliveryReceiptsForTest();
  });

  it("returns recorded receipts for the caller's session", async () => {
    recordReceipt("agent:main:parent", {
      target: { channel: "discord", to: "channel:1" },
      messageClass: "final_reply",
      outcome: "delivered",
      reason: "queued_system_event",
      ts: 100,
      resolvedContextAt: 100,
    });
    recordReceipt("agent:main:parent", {
      target: { channel: "discord", to: "channel:1" },
      messageClass: "progress",
      outcome: "suppressed",
      reason: "class_suppressed_for_surface",
      ts: 101,
      resolvedContextAt: 101,
    });

    const tool = createAcpReceiptsTool({ agentSessionKey: "agent:main:parent" });
    const result = await tool.execute("call-1", {});
    const details = result.details as {
      status: string;
      receipts: Array<{ outcome: string; reason?: string; sessionKeyHash: string }>;
    };
    expect(details.status).toBe("ok");
    expect(details.receipts).toHaveLength(2);
    expect(details.receipts[0]?.outcome).toBe("delivered");
    expect(details.receipts[1]?.outcome).toBe("suppressed");
    // Privacy: sessionKeyHash is a hex digest, NOT the raw key.
    expect(details.receipts[0]?.sessionKeyHash).not.toBe("agent:main:parent");
    expect(details.receipts[0]?.sessionKeyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies limit and returns the most-recent entries", async () => {
    for (let i = 0; i < 7; i += 1) {
      recordReceipt("agent:main:parent", {
        target: { channel: "discord", to: "channel:1" },
        messageClass: "progress",
        outcome: "delivered",
        reason: `r-${i}`,
        ts: i,
        resolvedContextAt: i,
      });
    }
    const tool = createAcpReceiptsTool({ agentSessionKey: "agent:main:parent" });
    const result = await tool.execute("call-1", { limit: 3 });
    const details = result.details as {
      receipts: Array<{ reason?: string }>;
    };
    expect(details.receipts).toHaveLength(3);
    expect(details.receipts.map((r) => r.reason)).toEqual(["r-4", "r-5", "r-6"]);
  });

  it("errors when no session context is available", async () => {
    const tool = createAcpReceiptsTool({});
    // Overwrite the mocked effectiveRequesterKey to empty so the caller session
    // fallback returns nothing.
    hoisted.resolveSessionToolContextMock.mockReturnValueOnce({
      cfg: {} as never,
      mainKey: "main",
      alias: "main",
      requesterInternalKey: "" as unknown as string,
      effectiveRequesterKey: "",
      restrictToSpawned: false,
    });
    const result = await tool.execute("call-1", {});
    const details = result.details as { status: string; error: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/sessionKey/);
  });

  it("honors visibility guard denial", async () => {
    hoisted.createSessionVisibilityGuardMock.mockResolvedValueOnce({
      check: () => ({
        allowed: false,
        status: "forbidden" as const,
        error: "denied",
      }),
    });
    const tool = createAcpReceiptsTool({ agentSessionKey: "agent:main:parent" });
    const result = await tool.execute("call-1", {
      sessionKey: "agent:other:parent",
    });
    const details = result.details as { status: string; error: string };
    expect(details.status).toBe("forbidden");
    expect(details.error).toBe("denied");
  });
});
