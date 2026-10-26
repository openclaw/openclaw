import { afterEach, expect, it, vi } from "vitest";
import { createQuestionReactionTargetStore } from "./question-gateway-runtime.js";

type Options = Parameters<typeof createQuestionReactionTargetStore>[0];
const questionId = "ask_0123456789abcdef0123456789abcdef";
const binding = { questionId, optionValues: ["One", "Two"] };
const identity = { accountId: "default", messageId: "message-1" };
const gatewayUrl = "ws://127.0.0.1:1234";
const resolveDefaults = { identities: [identity], cfg: {}, senderId: "sender-1", gatewayUrl };
const staleMessage = `test: stale question reaction ignored id=${questionId}`;

function fixture(overrides: Pick<Options, "ttlMs" | "registerChannelDelivery"> = {}) {
  const resolveReaction = vi.fn<NonNullable<Options["resolveReaction"]>>();
  const logDebug = vi.fn();
  const store = createQuestionReactionTargetStore({
    channel: "test",
    channelDisplayName: "Test",
    buildKey: ({ accountId, messageId }: typeof identity) => `${accountId}:${messageId}`,
    registerChannelDelivery: vi.fn<NonNullable<Options["registerChannelDelivery"]>>(),
    resolveReaction,
    ...overrides,
  });
  const resolve = (optionIndex = 0) =>
    expect(store.resolve({ ...resolveDefaults, optionIndex, logDebug })).resolves.toBe(true);
  return {
    store,
    resolveReaction,
    logDebug,
    register: () => store.register(binding, identity),
    resolve,
  };
}
afterEach(() => vi.useRealTimers());

it("replaces target timers without letting the old timer delete the new target", () => {
  vi.useFakeTimers();
  const { store, register } = fixture({ ttlMs: 1_000 });
  expect(register()).toBe(true);
  vi.advanceTimersByTime(500);
  expect(register()).toBe(true);
  vi.advanceTimersByTime(500);
  expect(store.has([identity])).toBe(true);
  vi.advanceTimersByTime(500);
  expect(store.has([identity])).toBe(false);
});

it("registers the exact delivery id and honors synchronous finalization", async () => {
  const { register, resolve, resolveReaction, logDebug } = fixture({
    registerChannelDelivery: ({ questionId: id, deliveryId, finalize }) => {
      expect([id, deliveryId]).toEqual([questionId, "test-reaction:default:message-1"]);
      void finalize("answered");
    },
  });
  expect(register()).toBe(true);
  await resolve();
  expect(resolveReaction).not.toHaveBeenCalled();
  expect(logDebug).toHaveBeenCalledWith(staleMessage);
});

it("resolves once, terminalizes the target, and consumes later duplicates", async () => {
  const { register, resolve, resolveReaction, logDebug } = fixture();
  resolveReaction.mockResolvedValue({
    status: "answered",
    questionId: "choice",
    optionValue: "Two",
  });
  register();
  await resolve(1);
  await resolve(1);
  expect(resolveReaction).toHaveBeenCalledExactlyOnceWith({
    cfg: {},
    questionId,
    optionValue: "Two",
    senderId: "sender-1",
    gatewayUrl,
    clientDisplayName: "Test question (sender-1)",
  });
  expect(logDebug).toHaveBeenCalledWith(staleMessage);
});

it("consumes out-of-range choices and resolver failures without losing diagnostics", async () => {
  const { register, resolve, resolveReaction, logDebug } = fixture();
  resolveReaction.mockRejectedValue(new Error("gateway down"));
  register();
  await resolve(3);
  await resolve();
  expect(logDebug.mock.calls).toEqual([
    [`test: out-of-range question reaction ignored id=${questionId}`],
    [`test: question reaction failed id=${questionId}: Error: gateway down`],
  ]);
});
