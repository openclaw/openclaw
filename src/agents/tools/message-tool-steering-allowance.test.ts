import { describe, expect, it } from "vitest";
import { getInternalToolSteeringAllowance } from "../runtime/internal-hooks.js";
import { createMessageTool } from "./message-tool-execution.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";

function steeringAllowance(overrides: MessageToolOptions) {
  const tool = createMessageTool({
    config: { agents: { entries: { main: {} } } } as never,
    preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
    sourceReplyDeliveryMode: "message_tool_only",
    runMessageAction: (async () => {
      throw new Error("Steering allowance tests must not execute the message tool");
    }) as never,
    ...overrides,
  });
  const allowance = getInternalToolSteeringAllowance(tool);
  if (!allowance) {
    throw new Error("Expected the message tool to install a steering allowance");
  }
  return allowance;
}

describe("message tool steering allowance", () => {
  it("matches a threaded source reply on the current thread", () => {
    const allowance = steeringAllowance({
      currentChannelProvider: "slack",
      currentChannelId: "C123",
      currentMessagingTarget: "C123",
      currentThreadTs: "1710000000.001",
      currentMessageId: "1710000000.002",
    });

    expect(
      allowance({
        action: "send",
        target: "C123",
        threadId: "1710000000.001",
        message: "Answer for input A.",
        final: true,
      }),
    ).toBe(true);
    expect(
      allowance({
        action: "send",
        target: "C123",
        threadId: "1710000000.999",
        message: "Wrong thread.",
        final: true,
      }),
    ).toBe(false);
  });

  it("binds the effective agent account to source replies", () => {
    const allowance = steeringAllowance({
      currentChannelProvider: "telegram",
      currentChannelId: "chat-1",
      currentMessagingTarget: "chat-1",
      currentMessageId: "m1",
      agentAccountId: "work",
    });

    expect(
      allowance({
        action: "send",
        target: "chat-1",
        accountId: "work",
        message: "Answer for input A.",
        final: true,
      }),
    ).toBe(true);
    expect(
      allowance({
        action: "send",
        target: "chat-1",
        accountId: "personal",
        message: "Wrong account.",
        final: true,
      }),
    ).toBe(false);
  });

  it("checks reaction targets before accepting top-level placement", () => {
    const allowance = steeringAllowance({
      currentChannelProvider: "telegram",
      currentChannelId: "chat-1",
      currentMessagingTarget: "chat-1",
      currentMessageId: "42",
    });

    expect(
      allowance({
        action: "react",
        target: "chat-1",
        messageId: "42",
        emoji: "eyes",
        final: true,
        topLevel: true,
      }),
    ).toBe(true);
    expect(
      allowance({
        action: "react",
        target: "chat-2",
        messageId: "42",
        emoji: "eyes",
        final: true,
        topLevel: true,
      }),
    ).toBe(false);
  });
});
