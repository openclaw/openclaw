import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type ConversationRef,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { buildCommandTestParams } from "../commands.test-harness.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

const gatewayRequest = vi.hoisted(() => vi.fn());
vi.mock("../../../agents/tools/in-process-gateway.js", () => ({
  bindAgentToolGatewayRequest: () => gatewayRequest,
}));

const cfg = {
  agents: { ownership: "explicit", entries: { main: {}, work: {}, other: {} } },
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;
const boundSessionKey = "agent:work:acp:bound";
const binding: SessionBindingRecord = {
  bindingId: "target-owner-binding",
  targetKind: "session",
  targetSessionKey: boundSessionKey,
  status: "active",
  boundAt: 1,
  conversation: { channel: "webchat", accountId: "default", conversationId: "room" },
};
function resolveBinding(ref: ConversationRef): SessionBindingRecord | null {
  return ref.channel === binding.conversation.channel &&
    ref.accountId === binding.conversation.accountId &&
    ref.conversationId === binding.conversation.conversationId
    ? binding
    : null;
}
const adapter: SessionBindingAdapter = {
  channel: "webchat",
  accountId: "default",
  listBySession: (key) => (key === boundSessionKey ? [binding] : []),
  resolveByConversation: resolveBinding,
  resolveByConversationAsync: async (ref) => resolveBinding(ref),
};
beforeEach(() => {
  gatewayRequest.mockReset();
  registerSessionBindingAdapter(adapter);
});
afterEach(() => {
  unregisterSessionBindingAdapter({ channel: "webchat", accountId: "default", adapter });
});

function createParams(source: "text" | "native", body = "/acp status") {
  return buildCommandTestParams(body, cfg, {
    Provider: "webchat",
    Surface: "webchat",
    OriginatingChannel: "webchat",
    OriginatingTo: "room",
    AccountId: "default",
    CommandSource: source,
    ...(source === "native" ? { CommandTargetSessionKey: "agent:main:main" } : {}),
  });
}

it.each(["text", "native"] as const)(
  "prefers the conversation binding over %s command context",
  async (source) => {
    await expect(
      resolveAcpTargetSessionKey({ commandParams: createParams(source) }),
    ).resolves.toEqual({
      ok: true,
      agentId: "work",
      sessionKey: boundSessionKey,
    });
    expect(gatewayRequest).not.toHaveBeenCalled();
  },
);

it("prefers an explicit ACP argument over the binding and native chat target", async () => {
  const explicitSessionKey = "agent:other:acp:selected";
  gatewayRequest.mockResolvedValue({ key: explicitSessionKey, agentId: "other" });
  await expect(
    resolveAcpTargetSessionKey({
      commandParams: createParams("native", `/acp status ${explicitSessionKey}`),
      token: explicitSessionKey,
    }),
  ).resolves.toEqual({ ok: true, agentId: "other", sessionKey: explicitSessionKey });
  expect(gatewayRequest).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: "sessions.resolve",
      params: expect.objectContaining({
        key: explicitSessionKey,
        allowMissing: true,
        agentId: "other",
      }),
    }),
  );
});
