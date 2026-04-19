import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { runSessionsSendA2AFlow, __testing } from "./sessions-send-tool.a2a.js";

vi.mock("../run-wait.js", () => ({
  waitForAgentRun: vi.fn().mockResolvedValue({ status: "ok" }),
  readLatestAssistantReply: vi.fn().mockResolvedValue("Test announce reply"),
}));

const mockRunAgentStep = vi.fn().mockResolvedValue("<announce>Test announce reply</announce>");

vi.mock("./agent-step.js", () => ({
  runAgentStep: (...args: unknown[]) => mockRunAgentStep(...args),
}));

describe("runSessionsSendA2AFlow announce delivery", () => {
  let gatewayCalls: CallGatewayOptions[];

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    gatewayCalls = [];
    mockRunAgentStep.mockResolvedValue("<announce>Test announce reply</announce>");
    __testing.setDepsForTest({
      callGateway: async <T = Record<string, unknown>>(opts: CallGatewayOptions) => {
        gatewayCalls.push(opts);
        return {} as T;
      },
    });
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

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
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

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.channel).toBe("discord");
    expect(sendParams.threadId).toBeUndefined();
  });

  it("delivers only inner content from <announce> tags", async () => {
    mockRunAgentStep.mockResolvedValue(
      "Internal reasoning here\n<announce>User-facing summary</announce>\nMore internal text",
    );

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall?.params as Record<string, unknown>;
    expect(sendParams.message).toBe("User-facing summary");
  });

  it("blocks untagged announce replies from being externalized", async () => {
    mockRunAgentStep.mockResolvedValue(
      "I have completed the task. The worker finished processing the request successfully.",
    );

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeUndefined();
  });

  it("blocks empty <announce> tags from being externalized", async () => {
    mockRunAgentStep.mockResolvedValue("<announce>   </announce>");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeUndefined();
  });

  it("handles ANNOUNCE_SKIP token as before", async () => {
    mockRunAgentStep.mockResolvedValue("ANNOUNCE_SKIP");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      message: "Test message",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 0,
      roundOneReply: "Worker completed successfully",
    });

    const sendCall = gatewayCalls.find((call) => call.method === "send");
    expect(sendCall).toBeUndefined();
  });
});
