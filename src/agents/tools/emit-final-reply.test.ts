import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendMessageMock: vi.fn<(args: unknown) => unknown>(),
  enqueueSystemEventMock: vi.fn<(text: string, opts: unknown) => void>(),
  planDeliveryMock: vi.fn<(args: unknown) => { outcome: "deliver" | "suppress"; reason?: string }>(
    () => ({ outcome: "deliver" as const }),
  ),
  listBySessionMock: vi.fn<(key: string) => unknown[]>(() => []),
  resolveSessionToolContextMock: vi.fn(() => ({
    cfg: {} as never,
    mainKey: "main",
    alias: "main",
    requesterInternalKey: "agent:main:parent",
    effectiveRequesterKey: "agent:main:parent",
    restrictToSpawned: false,
  })),
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: (args: unknown) => hoisted.sendMessageMock(args),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (text: string, opts: unknown) => hoisted.enqueueSystemEventMock(text, opts),
}));

vi.mock("../../infra/outbound/surface-policy.js", () => ({
  planDelivery: (args: unknown) => hoisted.planDeliveryMock(args),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: (key: string) => hoisted.listBySessionMock(key),
  }),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    resolveSessionToolContext: () => hoisted.resolveSessionToolContextMock(),
  };
});

describe("emit_final_reply tool", () => {
  let createEmitFinalReplyTool: typeof import("./emit-final-reply-tool.js").createEmitFinalReplyTool;
  let listReceiptsForSession: typeof import("../../infra/outbound/delivery-receipts.js").listReceiptsForSession;
  let resetDeliveryReceiptsForTest: typeof import("../../infra/outbound/delivery-receipts.js").resetDeliveryReceiptsForTest;

  beforeEach(async () => {
    vi.clearAllMocks();
    hoisted.planDeliveryMock.mockReturnValue({ outcome: "deliver" });
    hoisted.sendMessageMock.mockResolvedValue({
      channel: "discord",
      to: "channel:1",
      via: "direct",
      mediaUrl: null,
      result: { messageId: "msg-42" },
    });
    hoisted.listBySessionMock.mockReturnValue([]);
    ({ createEmitFinalReplyTool } = await import("./emit-final-reply-tool.js"));
    ({ listReceiptsForSession, resetDeliveryReceiptsForTest } =
      await import("../../infra/outbound/delivery-receipts.js"));
    resetDeliveryReceiptsForTest();
  });

  it("directly posts a final_reply when thread-bound and records a receipt", async () => {
    const tool = createEmitFinalReplyTool({
      agentSessionKey: "agent:main:parent",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:1",
      agentThreadId: "thread-1",
    });
    const result = await tool.execute("call-1", { text: "Here is my final answer." });
    const details = result.details as { status: string; mode: string; messageId?: string };
    expect(details.status).toBe("ok");
    expect(details.mode).toBe("direct");
    expect(details.messageId).toBe("msg-42");
    expect(hoisted.sendMessageMock).toHaveBeenCalledOnce();
    expect(hoisted.enqueueSystemEventMock).not.toHaveBeenCalled();
    const receipts = listReceiptsForSession("agent:main:parent");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe("delivered");
    expect(receipts[0]?.reason).toBe("agent_explicit_override");
    expect(receipts[0]?.messageClass).toBe("final_reply");
  });

  it("falls back to enqueueSystemEvent when not thread-bound", async () => {
    const tool = createEmitFinalReplyTool({
      agentSessionKey: "agent:main:parent",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:1",
      // no threadId
    });
    const result = await tool.execute("call-1", { text: "Final answer." });
    const details = result.details as { status: string; mode: string };
    expect(details.status).toBe("ok");
    expect(details.mode).toBe("queued");
    expect(hoisted.enqueueSystemEventMock).toHaveBeenCalledOnce();
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    const receipts = listReceiptsForSession("agent:main:parent");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reason).toBe("agent_explicit_override");
  });

  it("records a suppressed receipt when planDelivery suppresses", async () => {
    hoisted.planDeliveryMock.mockReturnValue({
      outcome: "suppress",
      reason: "no_origin",
    });
    const tool = createEmitFinalReplyTool({
      agentSessionKey: "agent:main:parent",
      // Missing channel/to — suppressed per Phase 4 origin-respect.
    });
    const result = await tool.execute("call-1", { text: "Answer." });
    const details = result.details as { status: string; reason: string };
    expect(details.status).toBe("suppressed");
    expect(details.reason).toBe("no_origin");
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    expect(hoisted.enqueueSystemEventMock).not.toHaveBeenCalled();
    const receipts = listReceiptsForSession("agent:main:parent");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe("suppressed");
    expect(receipts[0]?.reason).toContain("agent_explicit_override");
  });

  it("rejects empty text via schema-level required", async () => {
    const tool = createEmitFinalReplyTool({
      agentSessionKey: "agent:main:parent",
    });
    await expect(tool.execute("call-1", { text: "" })).rejects.toThrow();
  });

  it("bypasses classification regardless of inbound class heuristics", async () => {
    // Even though the text would normally classify as internal_narration,
    // emit_final_reply should force messageClass=final_reply on the receipt.
    const tool = createEmitFinalReplyTool({
      agentSessionKey: "agent:main:parent",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:1",
      agentThreadId: "thread-1",
    });
    await tool.execute("call-1", { text: "internal debug note" });
    const planCall = hoisted.planDeliveryMock.mock.calls[0]?.[0];
    const messageClass = (planCall as { messageClass?: string } | undefined)?.messageClass;
    expect(messageClass).toBe("final_reply");
  });
});
