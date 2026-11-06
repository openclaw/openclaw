/**
 * General channel contract test helpers.
 *
 * Provides reusable outbound send mocks and inbound contract assertions.
 */
import { expect, type Mock } from "vitest";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { normalizeChatType } from "../../chat-type.js";
import { resolveConversationLabel } from "../../conversation-label.js";

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper preserves channel send mock arg types.
export function primeChannelOutboundSendMock<TArgs extends unknown[]>(
  sendMock: Mock<(...args: TArgs) => Promise<unknown>>,
  fallbackResult: Record<string, unknown>,
  sendResults: Record<string, unknown>[] = [],
) {
  sendMock.mockReset();
  if (sendResults.length === 0) {
    sendMock.mockResolvedValue(fallbackResult as never);
    return;
  }
  for (const result of sendResults) {
    sendMock.mockResolvedValueOnce(result as never);
  }
}

function normalizeContextString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function expectChannelInboundContextContract(ctx: MsgContext) {
  expect(ctx.Body).toBeTypeOf("string");
  expect(ctx.BodyForAgent).toBeTypeOf("string");
  expect(ctx.BodyForCommands).toBeTypeOf("string");

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType !== "direct") {
    const senderValues = [
      normalizeContextString(ctx.SenderId),
      normalizeContextString(ctx.SenderName),
      normalizeContextString(ctx.SenderUsername),
      normalizeContextString(ctx.SenderE164),
    ].filter(Boolean);
    expect(senderValues.length).toBeGreaterThan(0);
  }

  if (chatType && chatType !== "direct") {
    const label = ctx.ConversationLabel?.trim() || resolveConversationLabel(ctx);
    expect(label).toBeTruthy();
  }

  const senderE164 = normalizeContextString(ctx.SenderE164);
  if (senderE164) {
    expect(senderE164).toMatch(/^\+\d{3,}$/);
  }

  const senderUsername = normalizeContextString(ctx.SenderUsername);
  if (senderUsername) {
    expect(senderUsername).not.toContain("@");
    expect(senderUsername).not.toMatch(/\s/);
  }

  if (ctx.SenderId != null) {
    expect(normalizeContextString(ctx.SenderId)).toBeTruthy();
  }
}
