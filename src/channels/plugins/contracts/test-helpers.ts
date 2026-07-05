/**
 * General channel contract test helpers.
 *
 * Provides reusable outbound send mocks and inbound/dispatch contract assertions.
 */
import { expect, type Mock } from "vitest";
import type { DispatchFromConfigResult } from "../../../auto-reply/reply/dispatch-from-config.types.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { normalizeChatType } from "../../chat-type.js";
import { resolveConversationLabel } from "../../conversation-label.js";
<<<<<<< HEAD
=======
import { validateSenderIdentity } from "../../sender-identity.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
  type ChannelTurnDispatchResultLike,
} from "../../turn/dispatch-result.js";

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

<<<<<<< HEAD
function normalizeContextString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function expectChannelInboundContextContract(ctx: MsgContext) {
=======
export function expectChannelInboundContextContract(ctx: MsgContext) {
  expect(validateSenderIdentity(ctx)).toEqual([]);

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  expect(ctx.Body).toBeTypeOf("string");
  expect(ctx.BodyForAgent).toBeTypeOf("string");
  expect(ctx.BodyForCommands).toBeTypeOf("string");

  const chatType = normalizeChatType(ctx.ChatType);
<<<<<<< HEAD
  if (chatType !== "direct") {
    const senderValues = [
      normalizeContextString(ctx.SenderId),
      normalizeContextString(ctx.SenderName),
      normalizeContextString(ctx.SenderUsername),
      normalizeContextString(ctx.SenderE164),
    ].filter(Boolean);
    expect(senderValues.length).toBeGreaterThan(0);
  }

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (chatType && chatType !== "direct") {
    const label = ctx.ConversationLabel?.trim() || resolveConversationLabel(ctx);
    expect(label).toBeTruthy();
  }
<<<<<<< HEAD

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
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

export function expectChannelTurnDispatchResultContract(
  result: ChannelTurnDispatchResultLike,
  expected: {
    visible: boolean;
    final?: boolean;
    counts?: Partial<DispatchFromConfigResult["counts"]>;
  },
) {
  expect(hasVisibleChannelTurnDispatch(result)).toBe(expected.visible);
  if (expected.final !== undefined) {
    expect(hasFinalChannelTurnDispatch(result)).toBe(expected.final);
  }
  if (expected.counts) {
    expect(resolveChannelTurnDispatchCounts(result)).toMatchObject(expected.counts);
  }
}
