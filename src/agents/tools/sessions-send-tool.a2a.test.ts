import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { runSessionsSendA2AFlow, __testing } from "./sessions-send-tool.a2a.js";

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
  readLatestAssistantReply: vi.fn().mockResolvedValue("Test announce reply"),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: vi.fn().mockResolvedValue("Test announce reply"),
}));

describe("runSessionsSendA2AFlow announce delivery", () => {
  let mockCallGateway: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    mockCallGateway = vi.fn().mockResolvedValue({});
    __testing.setDepsForTest({ callGateway: mockCallGateway });
  });

  afterEach(() => {
    __testing.setDepsForTest();
    vi.restoreAllMocks();
  });

  it("passes threadId through to gateway send for Telegram forum topics", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-100123:topic:554",
      displayKey: "agent:main:telegram:group:-100123:topic:554",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    // Find the gateway send call (not the waitForAgentRun call)
    const sendCall = mockCallGateway.mock.calls.find(
      (call: unknown[]) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCall).toBeDefined();
    const sendParams = (sendCall![0] as { params: Record<string, unknown> }).params;
    expect(sendParams.to).toBe("-100123");
    expect(sendParams.channel).toBe("telegram");
    expect(sendParams.threadId).toBe("554");
  });

  it("omits threadId for non-topic sessions", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = mockCallGateway.mock.calls.find(
      (call: unknown[]) => (call[0] as { method: string }).method === "send",
    );
    expect(sendCall).toBeDefined();
    const sendParams = (sendCall![0] as { params: Record<string, unknown> }).params;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });
});
