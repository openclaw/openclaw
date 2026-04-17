import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getTaskByIdMock: vi.fn<(taskId: string) => unknown>(),
  hasBackingSessionMock: vi.fn<(task: unknown) => boolean>(() => false),
  listBySessionMock: vi.fn<(key: string) => unknown[]>(() => []),
  sendMessageMock: vi.fn<(args: unknown) => unknown>(),
  planDeliveryMock: vi.fn<(args: unknown) => { outcome: "deliver" | "suppress"; reason?: string }>(
    () => ({ outcome: "deliver" as const }),
  ),
}));

vi.mock("../../tasks/task-registry.js", () => ({
  getTaskById: (taskId: string) => hoisted.getTaskByIdMock(taskId),
}));

vi.mock("../../tasks/task-registry.maintenance.js", () => ({
  hasBackingSession: (task: unknown) => hoisted.hasBackingSessionMock(task),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    listBySession: (key: string) => hoisted.listBySessionMock(key),
  }),
}));

vi.mock("../../infra/outbound/message.js", () => ({
  sendMessage: (args: unknown) => hoisted.sendMessageMock(args),
}));

vi.mock("../../infra/outbound/surface-policy.js", () => ({
  planDelivery: (args: unknown) => hoisted.planDeliveryMock(args),
}));

function activeBinding(overrides: Partial<{ conversationId: string; channel: string }> = {}) {
  return {
    bindingId: "b-1",
    targetSessionKey: "agent:main:child",
    targetKind: "session" as const,
    conversation: {
      channel: overrides.channel ?? "discord",
      accountId: "default",
      conversationId: overrides.conversationId ?? "thread-42",
      parentConversationId: "channel-1",
    },
    status: "active" as const,
    boundAt: Date.now(),
  };
}

describe("resume_for_task tool", () => {
  let createResumeForTaskTool: typeof import("./resume-for-task-tool.js").createResumeForTaskTool;
  let listReceiptsForSession: typeof import("../../infra/outbound/delivery-receipts.js").listReceiptsForSession;
  let resetDeliveryReceiptsForTest: typeof import("../../infra/outbound/delivery-receipts.js").resetDeliveryReceiptsForTest;

  beforeEach(async () => {
    vi.clearAllMocks();
    hoisted.planDeliveryMock.mockReturnValue({ outcome: "deliver" });
    hoisted.sendMessageMock.mockResolvedValue({
      channel: "discord",
      to: "channel:channel-1",
      via: "direct",
      mediaUrl: null,
      result: { messageId: "msg-777" },
    });
    hoisted.hasBackingSessionMock.mockReturnValue(false);
    ({ createResumeForTaskTool } = await import("./resume-for-task-tool.js"));
    ({ listReceiptsForSession, resetDeliveryReceiptsForTest } =
      await import("../../infra/outbound/delivery-receipts.js"));
    resetDeliveryReceiptsForTest();
  });

  it("fails closed when the task is missing", async () => {
    hoisted.getTaskByIdMock.mockReturnValue(undefined);
    const tool = createResumeForTaskTool();
    const result = await tool.execute("call-1", { taskId: "t-unknown", message: "wake" });
    const details = result.details as { status: string };
    expect(details.status).toBe("not_found");
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
  });

  it("fails closed when there is no active binding", async () => {
    hoisted.getTaskByIdMock.mockReturnValue({
      taskId: "t-1",
      runtime: "acp",
      status: "running",
      childSessionKey: "agent:main:child",
      requesterSessionKey: "agent:main:parent",
    });
    hoisted.listBySessionMock.mockReturnValue([]);
    const tool = createResumeForTaskTool();
    const result = await tool.execute("call-1", { taskId: "t-1", message: "wake" });
    const details = result.details as { status: string };
    expect(details.status).toBe("no_binding");
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
  });

  it("fails closed when task status is terminal", async () => {
    hoisted.getTaskByIdMock.mockReturnValue({
      taskId: "t-1",
      runtime: "acp",
      status: "succeeded",
      childSessionKey: "agent:main:child",
      requesterSessionKey: "agent:main:parent",
    });
    hoisted.listBySessionMock.mockReturnValue([activeBinding()]);
    const tool = createResumeForTaskTool();
    const result = await tool.execute("call-1", { taskId: "t-1", message: "wake" });
    const details = result.details as { status: string };
    expect(details.status).toBe("bad_state");
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
  });

  it("fails closed when the task still has a backing session", async () => {
    hoisted.getTaskByIdMock.mockReturnValue({
      taskId: "t-1",
      runtime: "acp",
      status: "running",
      childSessionKey: "agent:main:child",
      requesterSessionKey: "agent:main:parent",
    });
    hoisted.listBySessionMock.mockReturnValue([activeBinding()]);
    hoisted.hasBackingSessionMock.mockReturnValue(true);
    const tool = createResumeForTaskTool();
    const result = await tool.execute("call-1", { taskId: "t-1", message: "wake" });
    const details = result.details as { status: string };
    expect(details.status).toBe("bad_state");
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
  });

  it("delivers to the bound surface (NOT an operator channel) on the happy path", async () => {
    hoisted.getTaskByIdMock.mockReturnValue({
      taskId: "t-1",
      runtime: "acp",
      status: "lost",
      childSessionKey: "agent:main:child",
      requesterSessionKey: "agent:main:parent",
    });
    hoisted.listBySessionMock.mockReturnValue([activeBinding()]);
    const tool = createResumeForTaskTool();
    const result = await tool.execute("call-1", { taskId: "t-1", message: "please resume" });
    const details = result.details as { status: string; messageId?: string };
    expect(details.status).toBe("ok");
    expect(details.messageId).toBe("msg-777");
    expect(hoisted.sendMessageMock).toHaveBeenCalledOnce();
    const sendArgs = hoisted.sendMessageMock.mock.calls[0]?.[0] as {
      channel: string;
      to: string;
      messageClass: string;
      threadId?: unknown;
    };
    // Phase 4 rework: routes to the bound surface, NOT an operator bucket.
    expect(sendArgs.channel).toBe("discord");
    expect(sendArgs.to).toBe("channel:channel-1");
    expect(sendArgs.threadId).toBe("thread-42");
    expect(sendArgs.messageClass).toBe("resume");
    const receipts = listReceiptsForSession("agent:main:child");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe("delivered");
    expect(receipts[0]?.reason).toBe("operator_resume_escape_hatch");
  });

  it("suppresses + records when planDelivery suppresses (no origin)", async () => {
    hoisted.getTaskByIdMock.mockReturnValue({
      taskId: "t-1",
      runtime: "acp",
      status: "running",
      childSessionKey: "agent:main:child",
      requesterSessionKey: "agent:main:parent",
    });
    hoisted.listBySessionMock.mockReturnValue([activeBinding()]);
    hoisted.planDeliveryMock.mockReturnValue({
      outcome: "suppress",
      reason: "no_origin",
    });
    const tool = createResumeForTaskTool();
    const result = await tool.execute("call-1", { taskId: "t-1", message: "wake" });
    const details = result.details as { status: string; reason: string };
    expect(details.status).toBe("suppressed");
    expect(details.reason).toBe("no_origin");
    expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    const receipts = listReceiptsForSession("agent:main:child");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe("suppressed");
    expect(receipts[0]?.reason).toContain("operator_resume_escape_hatch");
  });

  it("prefers childSessionKey over requesterSessionKey when resolving the session", async () => {
    hoisted.getTaskByIdMock.mockReturnValue({
      taskId: "t-1",
      runtime: "acp",
      status: "running",
      childSessionKey: "agent:main:child",
      requesterSessionKey: "agent:main:parent",
    });
    hoisted.listBySessionMock.mockReturnValue([activeBinding()]);
    const tool = createResumeForTaskTool();
    await tool.execute("call-1", { taskId: "t-1", message: "wake" });
    // First call resolves the childSessionKey for binding lookup.
    const firstCallKey = hoisted.listBySessionMock.mock.calls[0]?.[0];
    expect(firstCallKey).toBe("agent:main:child");
  });

  it("is owner-only (flag)", async () => {
    const tool = createResumeForTaskTool();
    expect(tool.ownerOnly).toBe(true);
  });
});
