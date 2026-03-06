import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
} from "../../infra/outbound/session-binding-service.js";
import {
  createSlackThreadBindingManager,
  getSlackThreadBindingManager,
} from "./thread-bindings.manager.js";
import { resetSlackThreadBindingsForTests } from "./thread-bindings.state.js";

vi.mock("../client.js", () => ({
  createSlackWebClient: () => ({
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "9999999999.999999" }),
    },
  }),
}));

describe("slack thread-bindings manager", () => {
  beforeEach(() => {
    resetSlackThreadBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  afterEach(() => {
    resetSlackThreadBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("creates and registers a manager", () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    expect(manager.accountId).toBe("test");
    expect(getSlackThreadBindingManager("test")).toBe(manager);
  });

  it("returns existing manager on duplicate create", () => {
    const m1 = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    const m2 = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test2",
      persist: false,
      enableSweeper: false,
    });
    expect(m1).toBe(m2);
  });

  it("binds and resolves by thread", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    const record = await manager.bindTarget({
      threadId: "1234567890.123456",
      channelId: "C123",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
      agentId: "test",
      boundBy: "U999",
    });
    expect(record).not.toBeNull();
    expect(record!.threadId).toBe("1234567890.123456");
    expect(record!.channelId).toBe("C123");

    const found = manager.getByThreadId("1234567890.123456");
    expect(found).toBeDefined();
    expect(found!.targetSessionKey).toBe("agent:test:acp:session1");
  });

  it("binds with child placement (creates thread)", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    const record = await manager.bindTarget({
      channelId: "C123",
      createThread: true,
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session2",
      agentId: "test",
      boundBy: "U999",
      threadName: "Test Thread",
    });
    expect(record).not.toBeNull();
    // The mocked postMessage returns ts=9999999999.999999
    expect(record!.threadId).toBe("9999999999.999999");
    expect(record!.channelId).toBe("C123");
  });

  it("unbinds by thread id", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    await manager.bindTarget({
      threadId: "1234567890.123456",
      channelId: "C123",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
    });
    const removed = manager.unbindThread({
      threadId: "1234567890.123456",
      sendFarewell: false,
    });
    expect(removed).not.toBeNull();
    expect(manager.getByThreadId("1234567890.123456")).toBeUndefined();
  });

  it("unbinds by session key", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    await manager.bindTarget({
      threadId: "1234567890.123456",
      channelId: "C123",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
    });
    const removed = manager.unbindBySessionKey({
      targetSessionKey: "agent:test:acp:session1",
      sendFarewell: false,
    });
    expect(removed).toHaveLength(1);
    expect(manager.listBindings()).toHaveLength(0);
  });

  it("touches thread activity", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    await manager.bindTarget({
      threadId: "1234567890.123456",
      channelId: "C123",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
    });
    const before = manager.getByThreadId("1234567890.123456")!.lastActivityAt;
    const touched = manager.touchThread({
      threadId: "1234567890.123456",
      at: before + 5000,
    });
    expect(touched).not.toBeNull();
    expect(touched!.lastActivityAt).toBe(before + 5000);
  });

  it("requires channelId when thread_ts collides across channels", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    const threadTs = "1234567890.123456";
    await manager.bindTarget({
      threadId: threadTs,
      channelId: "C111",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
    });
    await manager.bindTarget({
      threadId: threadTs,
      channelId: "C222",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session2",
    });

    expect(manager.getByThreadId(threadTs)).toBeUndefined();
    expect(
      manager.touchThread({
        threadId: threadTs,
        at: Date.now() + 1_000,
      }),
    ).toBeNull();

    const touched = manager.touchThread({
      channelId: "C111",
      threadId: threadTs,
      at: Date.now() + 2_000,
    });
    expect(touched).not.toBeNull();
    expect(touched!.channelId).toBe("C111");

    const removed = manager.unbindThread({
      channelId: "C222",
      threadId: threadTs,
      sendFarewell: false,
    });
    expect(removed).not.toBeNull();
    expect(removed!.channelId).toBe("C222");
    expect(manager.listBindings()).toHaveLength(1);
  });

  it("registers session binding adapter", async () => {
    createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    const service = getSessionBindingService();
    const caps = service.getCapabilities({ channel: "slack", accountId: "test" });
    expect(caps.adapterAvailable).toBe(true);
    expect(caps.bindSupported).toBe(true);
    expect(caps.placements).toContain("current");
    expect(caps.placements).toContain("child");
  });

  it("resolves binding via session binding service", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    await manager.bindTarget({
      threadId: "1234567890.123456",
      channelId: "C123",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
      agentId: "test",
    });

    const service = getSessionBindingService();
    const found = service.resolveByConversation({
      channel: "slack",
      accountId: "test",
      conversationId: "1234567890.123456",
      parentConversationId: "C123",
    });
    expect(found).not.toBeNull();
    expect(found!.targetSessionKey).toBe("agent:test:acp:session1");
    expect(found!.conversation.channel).toBe("slack");
  });

  it("resolves binding by thread_ts when parent channel is unavailable", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    await manager.bindTarget({
      threadId: "1234567890.123456",
      channelId: "C123",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
      agentId: "test",
    });

    const service = getSessionBindingService();
    const found = service.resolveByConversation({
      channel: "slack",
      accountId: "test",
      conversationId: "1234567890.123456",
    });
    expect(found).not.toBeNull();
    expect(found!.targetSessionKey).toBe("agent:test:acp:session1");
    expect(found!.conversation.parentConversationId).toBe("C123");
  });

  it("returns null without parent channel when thread_ts is ambiguous", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    const threadTs = "1234567890.123456";
    await manager.bindTarget({
      threadId: threadTs,
      channelId: "C111",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
    });
    await manager.bindTarget({
      threadId: threadTs,
      channelId: "C222",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session2",
    });

    const service = getSessionBindingService();
    const found = service.resolveByConversation({
      channel: "slack",
      accountId: "test",
      conversationId: threadTs,
    });
    expect(found).toBeNull();
  });

  it("lists bindings by session via service", async () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    await manager.bindTarget({
      threadId: "1234567890.123456",
      channelId: "C123",
      targetKind: "acp",
      targetSessionKey: "agent:test:acp:session1",
    });

    const service = getSessionBindingService();
    const bindings = service.listBySession("agent:test:acp:session1");
    expect(bindings).toHaveLength(1);
    expect(bindings[0].conversation.conversationId).toBe("1234567890.123456");
  });

  it("unregisters adapter on stop", () => {
    const manager = createSlackThreadBindingManager({
      accountId: "test",
      token: "xoxb-test",
      persist: false,
      enableSweeper: false,
    });
    const service = getSessionBindingService();
    expect(service.getCapabilities({ channel: "slack", accountId: "test" }).adapterAvailable).toBe(
      true,
    );
    manager.stop();
    expect(service.getCapabilities({ channel: "slack", accountId: "test" }).adapterAvailable).toBe(
      false,
    );
    expect(getSlackThreadBindingManager("test")).toBeNull();
  });
});
