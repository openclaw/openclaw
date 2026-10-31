/** Verifies a bound conversation's ownership check runs again before a reloaded plugin receives its claim. */
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveConversationBindingSelection,
  withConversationBindingRouteFacts,
} from "../../channels/conversation-binding-route-facts.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type ConversationRef,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { withClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import type { MsgContext } from "../templating.js";
import { assertPreparedConversationBindingRouteCurrent } from "./session-conversation-binding.js";

const channel = { channel: "webchat", accountId: "default" };
const conversation: ConversationRef = { ...channel, conversationId: "room" };
const ownerBinding: SessionBindingRecord = {
  bindingId: "binding-1",
  targetSessionKey: "agent:main:bound",
  targetKind: "session",
  conversation,
  status: "active",
  boundAt: 1,
  metadata: { pluginBindingOwner: "plugin", pluginId: "claim-owner", pluginRoot: "/plugins/claim" },
};
const adapters: SessionBindingAdapter[] = [];

// The conversation binding owner, whose current record a test changes mid-reload.
function registerBindingOwner(initial: SessionBindingRecord) {
  let current: SessionBindingRecord | null = initial;
  const lookup = () => current;
  const adapter: SessionBindingAdapter = {
    ...channel,
    listBySession: () => (current ? [current] : []),
    inspectByConversation: lookup,
    resolveByConversation: lookup,
    inspectByConversationAsync: async () => lookup(),
    resolveByConversationAsync: async () => lookup(),
    touchAsync: async () => {},
  };
  adapters.push(adapter);
  registerSessionBindingAdapter(adapter);
  return {
    set(next: SessionBindingRecord | null) {
      current = next;
    },
  };
}

// Starts a targeted inbound claim, as ingress does for a plugin-owned binding,
// while a reload holds the owning plugin quiesced; publish() swaps in the replacement.
function startClaimDuringReload() {
  const previous = new PluginInstance("claim-owner");
  const replacement = new PluginInstance("claim-owner");
  const delivered: unknown[] = [];
  const registration = (instance: PluginInstance) => ({
    hookName: "inbound_claim",
    pluginId: "claim-owner",
    handler: instance.wrap((event: unknown) => {
      delivered.push(event);
      return { handled: true };
    }),
  });
  const registry = createMockPluginRegistry([registration(previous)]);
  const runner = createHookRunner(registry, { catchErrors: true });
  const release = previous.reserveReplacement();
  previous.quiesce();
  const ctx = withConversationBindingRouteFacts(
    { sessionKey: "agent:main:bound", agentId: "main", SessionKey: "agent:main:bound" },
    resolveConversationBindingSelection(ownerBinding),
    "main",
    conversation,
  ) as MsgContext & { sessionKey: string; agentId: string };
  const prepare = vi.fn(() => assertPreparedConversationBindingRouteCurrent(ctx));
  const claim = runner.runInboundClaimForPluginOutcome(
    "claim-owner",
    { content: "private message" } as never,
    withClaimingHookAdmission(
      { channelId: "webchat", pluginBinding: ownerBinding },
      { prepare },
    ) as never,
  );
  return {
    claim,
    delivered,
    prepare,
    async publish() {
      registry.typedHooks = createMockPluginRegistry([registration(replacement)]).typedHooks;
      release();
      await previous.dispose();
    },
  };
}

afterEach(() => {
  for (const adapter of adapters.splice(0)) {
    unregisterSessionBindingAdapter({ ...channel, adapter });
  }
});

describe("plugin-owned conversation claim across a plugin reload", () => {
  it("delivers the claim to the replacement while the binding still belongs to the plugin", async () => {
    registerBindingOwner(ownerBinding);
    const reload = startClaimDuringReload();
    await setImmediate();
    await reload.publish();

    await expect(reload.claim).resolves.toMatchObject({ status: "handled" });
    expect(reload.prepare).toHaveBeenCalledTimes(2);
    expect(reload.delivered).toEqual([{ content: "private message" }]);
  });

  it.each([
    {
      change: "reassigned to another plugin",
      next: {
        ...ownerBinding,
        bindingId: "binding-2",
        boundAt: 2,
        metadata: { pluginBindingOwner: "plugin", pluginId: "other", pluginRoot: "/plugins/other" },
      },
    },
    { change: "revoked", next: null },
  ])(
    "rejects before the replacement sees the message when the binding is $change during the reload",
    async ({ next }) => {
      const owner = registerBindingOwner(ownerBinding);
      const reload = startClaimDuringReload();
      await setImmediate();
      owner.set(next);
      await reload.publish();

      await expect(reload.claim).rejects.toThrow("Conversation binding changed");
      expect(reload.prepare).toHaveBeenCalledTimes(2);
      expect(reload.delivered).toEqual([]);
    },
  );
});
