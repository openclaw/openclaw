import { afterEach, expect, it, vi } from "vitest";
import { createQuestionReactionTargetStore } from "./question-gateway-runtime.js";

type RegisterChannelDelivery =
  typeof import("../infra/question-channel-runtime.js").registerQuestionChannelDelivery;
type ResolveReaction =
  typeof import("../infra/question-reaction-runtime.js").resolveQuestionReactionOverGateway;

const binding = {
  questionId: "ask_0123456789abcdef0123456789abcdef",
  optionValues: ["One", "Two"],
};
const identity = { accountId: "default", messageId: "message-1" };
const resolveDefaults = { identities: [identity], optionIndex: 0, cfg: {}, senderId: "sender-1" };
const staleMessage = `test: stale question reaction ignored id=${binding.questionId}`;
type StoreOptions = Parameters<typeof createQuestionReactionTargetStore>[0];

function createStore(
  overrides: Pick<StoreOptions, "ttlMs" | "registerChannelDelivery" | "resolveReaction"> = {},
) {
  return createQuestionReactionTargetStore({
    channel: "test",
    channelDisplayName: "Test",
    ttlMs: overrides.ttlMs,
    buildKey: (target: typeof identity) => {
      const accountId = target.accountId.trim();
      const messageId = target.messageId.trim();
      return accountId && messageId ? `${accountId}:${messageId}` : null;
    },
    registerChannelDelivery: overrides.registerChannelDelivery ?? vi.fn<RegisterChannelDelivery>(),
    resolveReaction: overrides.resolveReaction,
  });
}
type Store = ReturnType<typeof createStore>;
function resolve(store: Store, params: Partial<Parameters<Store["resolve"]>[0]> = {}) {
  return expect(store.resolve({ ...resolveDefaults, ...params })).resolves.toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

it("replaces target timers without letting the old timer delete the new target", () => {
  vi.useFakeTimers();
  const store = createStore({ ttlMs: 1_000 });

  expect(store.register(binding, identity)).toBe(true);
  vi.advanceTimersByTime(500);
  expect(store.register(binding, identity)).toBe(true);
  vi.advanceTimersByTime(500);
  expect(store.has([identity])).toBe(true);
  vi.advanceTimersByTime(500);
  expect(store.has([identity])).toBe(false);
});

it("registers the exact delivery id and honors synchronous finalization", async () => {
  const registerChannelDelivery = vi.fn<RegisterChannelDelivery>((params) => {
    void params.finalize("answered");
  });
  const resolveReaction = vi.fn<ResolveReaction>();
  const store = createStore({ registerChannelDelivery, resolveReaction });
  const logDebug = vi.fn();

  expect(store.register(binding, identity)).toBe(true);
  expect(registerChannelDelivery).toHaveBeenCalledWith(
    expect.objectContaining({
      questionId: binding.questionId,
      deliveryId: "test-reaction:default:message-1",
    }),
  );
  await resolve(store, { logDebug });
  expect(resolveReaction).not.toHaveBeenCalled();
  expect(logDebug).toHaveBeenCalledWith(staleMessage);
});

it("resolves once, terminalizes the target, and consumes later duplicates", async () => {
  const resolveReaction = vi.fn<ResolveReaction>().mockResolvedValue({
    status: "answered",
    questionId: "choice",
    optionValue: "Two",
  });
  const store = createStore({ resolveReaction });
  store.register(binding, identity);

  const resolveParams = {
    ...resolveDefaults,
    optionIndex: 1,
    gatewayUrl: "ws://127.0.0.1:1234",
    logDebug: vi.fn(),
  };
  await resolve(store, resolveParams);
  await resolve(store, resolveParams);

  expect(resolveReaction).toHaveBeenCalledExactlyOnceWith({
    cfg: {},
    questionId: binding.questionId,
    optionValue: "Two",
    senderId: "sender-1",
    gatewayUrl: "ws://127.0.0.1:1234",
    clientDisplayName: "Test question (sender-1)",
  });
  expect(resolveParams.logDebug).toHaveBeenCalledWith(staleMessage);
});

it("consumes out-of-range choices and resolver failures without losing diagnostics", async () => {
  const resolveReaction = vi.fn<ResolveReaction>().mockRejectedValue(new Error("gateway down"));
  const store = createStore({ resolveReaction });
  const outOfRange = { accountId: "default", messageId: "out-of-range" };
  const failure = { accountId: "default", messageId: "failure" };
  const logDebug = vi.fn();
  store.register(binding, outOfRange);
  store.register(binding, failure);

  await resolve(store, { identities: [outOfRange], optionIndex: 3, logDebug });
  await resolve(store, { identities: [failure], logDebug });

  expect(logDebug).toHaveBeenCalledWith(
    `test: out-of-range question reaction ignored id=${binding.questionId}`,
  );
  expect(logDebug).toHaveBeenCalledWith(
    `test: question reaction failed id=${binding.questionId}: Error: gateway down`,
  );
});
