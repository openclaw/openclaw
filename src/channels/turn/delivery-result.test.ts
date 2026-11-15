import { assert, expect, it } from "vitest";
import type { MessageReceipt } from "../message/types.js";
import {
  createAcceptedChannelDeliveryResult,
  createChannelDeliveryAccumulator,
  createChannelDeliveryResultFromReceipt,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "./delivery-result.js";
import {
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "./dispatch-result.js";

const receipt = (overrides: Partial<MessageReceipt> = {}): MessageReceipt => ({
  platformMessageIds: [],
  parts: [],
  sentAt: 123,
  ...overrides,
});

it("suppresses an empty batch and leaves failures before acceptance unchanged", () => {
  const accepted = createChannelDeliveryAccumulator();
  const error = new Error("send rejected");
  const partial = { visibleReplySent: true as const, messageIds: ["accepted-attachment"] };
  expect(accepted.result()).toEqual({
    visibleReplySent: false,
    suppression: { reason: "no_visible_result" },
  });
  expect(accepted.partialError(error)).toBe(error);
  expect(accepted.partialError(createChannelPartialDeliveryError(error, partial))).toMatchObject({
    deliveryResult: { ...partial, content: "" },
  });
});

it("keeps immutable snapshots and a nested failure's accepted subset in send order", () => {
  const accepted = createChannelDeliveryAccumulator({ kind: "media", replyToId: "parent" });
  const nested = receipt({
    platformMessageIds: ["last-attachment", "caption"],
    parts: [{ platformMessageId: "last-attachment", kind: "media", index: 0, threadId: "thread" }],
  });
  const prefix = { messageIds: ["first"], content: "first" };
  accepted.add({ messageId: "first" }, prefix.content);
  const snapshot = accepted.result();
  accepted.add({ messageId: "attachment" }, "");
  const failure = accepted.partialError(
    createChannelPartialDeliveryError(new Error("last caption rejected"), {
      visibleReplySent: true,
      messageIds: ["stale"],
      receipt: nested,
      content: "last",
    }),
  );
  expect(failure).toMatchObject({
    deliveryResult: {
      visibleReplySent: true,
      messageIds: ["first", "attachment", "last-attachment", "caption"],
      content: "first\nlast",
      receipt: { primaryPlatformMessageId: "first", replyToId: "parent" },
    },
  });
  assert(isChannelPartialDeliveryError(failure));
  expect(failure.deliveryResult.receipt?.parts[2]).toEqual({
    ...nested.parts[0],
    replyToId: "parent",
  });
  expect(failure.deliveryResult).not.toHaveProperty("threadId");
  expect(snapshot).toMatchObject({
    ...prefix,
    receipt: { raw: [{ messageId: "first" }] },
  });
  expect(accepted.result()).toMatchObject({
    messageIds: ["first", "attachment"],
    content: prefix.content,
  });
});
it("preserves identityless accepted delivery without inventing routing or text", () => {
  const result = createAcceptedChannelDeliveryResult({});
  expect(result).toMatchObject({
    messageIds: [],
    receipt: { platformMessageIds: [], parts: [] },
    visibleReplySent: true,
  });
  expect(result).not.toHaveProperty("content");
  expect(result).not.toHaveProperty("threadId");
});
it("keeps receipt IDs and routing instead of the requested route", () => {
  const input = receipt({ platformMessageIds: ["m1", "m2"], threadId: "canonical" });
  expect(createChannelDeliveryResultFromReceipt({ receipt: input, threadId: "requested" })).toEqual(
    {
      receipt: input,
      messageIds: ["m1", "m2"],
      threadId: "canonical",
    },
  );
});

it("preserves receipt identity without restoring a conflicting route", () => {
  const input = receipt({
    platformMessageIds: ["m1", "m2"],
    parts: [
      { platformMessageId: "m1", kind: "text", index: 0, threadId: "thread-1" },
      { platformMessageId: "m2", kind: "text", index: 1, threadId: "thread-2" },
    ],
  });
  const result = createChannelDeliveryResultFromReceipt({
    receipt: input,
    threadId: "requested",
  });
  expect(result.receipt).toBe(input);
  expect(result).toEqual({ receipt: input, messageIds: ["m1", "m2"] });
});

it("normalizes visible dispatch checks", () => {
  expect(hasVisibleChannelTurnDispatch(undefined)).toBe(false);
  expect(hasVisibleChannelTurnDispatch(undefined, { observedReplyDelivery: true })).toBe(true);
  expect(resolveChannelTurnDispatchCounts(undefined)).toEqual({ tool: 0, block: 0, final: 0 });
});
