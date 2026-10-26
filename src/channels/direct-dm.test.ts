import { expect, it, vi } from "vitest";
import { dispatchInboundDirectDm } from "./direct-dm.js";
import { buildChannelInboundEventContext } from "./inbound-event/context.js";
import { resolveStableChannelIngressPolicy } from "./message-access/runtime.js";
import type { ChannelTurnPlan } from "./turn/types.js";

const mocks = vi.hoisted(() => ({
  dispatchRoutedChannelTurn: vi.fn<(plan: ChannelTurnPlan) => Promise<void>>(async () => undefined),
  onModelSelected: vi.fn(),
}));

vi.mock("./inbound-event/context.js", () => ({
  buildChannelInboundEventContext: vi.fn(() => ({ Body: "envelope:hello" })),
}));

vi.mock("./inbound-event/envelope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound-event/envelope.js")>()),
  createChannelInboundEnvelopeBuilderAsync: vi.fn(async () => () => "envelope:hello"),
}));

vi.mock("../routing/resolve-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routing/resolve-route.js")>()),
  resolveAgentRoute: vi.fn(() => ({
    agentId: "agent-1",
    accountId: "account-1",
    sessionKey: "agent:agent-1:nostr:direct:peer-1",
  })),
}));

vi.mock("./message/reply-pipeline.js", () => ({
  createChannelReplyPipeline: vi.fn(() => ({
    humanDelay: { minMs: 1, maxMs: 2 },
    onModelSelected: mocks.onModelSelected,
  })),
}));

vi.mock("./turn/lifecycle.js", () => ({
  dispatchRoutedChannelTurn: mocks.dispatchRoutedChannelTurn,
}));

function dispatchDm(overrides: Partial<Parameters<typeof dispatchInboundDirectDm>[0]>) {
  return dispatchInboundDirectDm({
    cfg: {},
    channel: "nostr",
    channelLabel: "Nostr",
    accountId: "account-1",
    peer: { kind: "direct", id: "peer-1" },
    senderId: "peer-1",
    senderAddress: "nostr:peer-1",
    recipientAddress: "nostr:bot-1",
    conversationLabel: "peer-1",
    rawBody: "hello",
    messageId: "event-1",
    deliver: async () => undefined,
    onRecordError: vi.fn(),
    onDispatchError: vi.fn(),
    ...overrides,
  });
}

const contextParams = () => vi.mocked(buildChannelInboundEventContext).mock.calls.at(-1)?.[0];
const ingressPolicy = (
  contextBinding?: Parameters<typeof resolveStableChannelIngressPolicy>[0]["contextBinding"],
) =>
  resolveStableChannelIngressPolicy({
    channelId: "nostr",
    accountId: "account-1",
    subject: { stableId: "peer-1" },
    conversation: { kind: "direct", id: "peer-1" },
    dmPolicy: "open",
    contextBinding,
  });

it("dispatches resolved ingress through the canonical reply and adoption pipeline", async () => {
  const resolveChannelIngress = vi.fn(ingressPolicy);
  const assertAuthority = vi.fn();
  const turnAdoptionLifecycle = {
    admission: "exclusive" as const,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(),
    abortSignal: new AbortController().signal,
  };

  await dispatchDm({
    resolveChannelIngress,
    turnAdoptionLifecycle,
    assertAuthority,
  });

  expect(mocks.dispatchRoutedChannelTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      assertAuthority,
      replyPipeline: { humanDelay: { minMs: 1, maxMs: 2 } },
      replyOptions: { onModelSelected: mocks.onModelSelected, turnAdoptionLifecycle },
    }),
  );
  expect(assertAuthority).not.toHaveBeenCalled();
  expect(resolveChannelIngress).toHaveBeenCalledExactlyOnceWith({
    agentId: "agent-1",
    sessionKey: "agent:agent-1:nostr:direct:peer-1",
    messageId: "event-1",
    inboundEventKind: "user_request",
  });
  expect(contextParams()?.channelIngress).toBe(await resolveChannelIngress.mock.results[0]?.value);
});

it("preserves the shipped SDK contract for callers without ingress provenance", async () => {
  await dispatchDm({ channel: "external", channelLabel: "External" });

  expect(contextParams()?.channelIngress).toBeUndefined();
});

it("preserves Reef's explicit unsupported trust-path classification", async () => {
  const channelIngress = "unsupported";
  await dispatchDm({
    channelIngress,
    channel: "reef",
    channelLabel: "Reef",
    senderAddress: "reef:peer-1",
    recipientAddress: "reef:bot-1",
    inboundAccessAuthorized: true,
  });

  const context = contextParams();
  expect(context?.channelIngress).toBe("unsupported");
  expect(context?.reply).toEqual({ to: "reef:bot-1", originatingTo: "reef:peer-1" });
  expect(context?.conversation.routePeer).toEqual({ kind: "direct", id: "peer-1" });
});
