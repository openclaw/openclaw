import { describe, expect, it } from "vitest";
import {
  matchesConversationBindingRouteFacts,
  readConversationBindingRouteFacts,
  resolveConversationBindingSelection,
  withConversationBindingRouteFacts,
} from "../../channels/conversation-binding-route-facts.js";
import {
  matchesActiveSessionBindingSnapshot,
  matchesSessionBindingIdentity,
} from "./session-binding-identity.js";
import type { SessionBindingRecord } from "./session-binding.types.js";

function record(): SessionBindingRecord {
  return {
    bindingId: "fixture:binding",
    generation: "generation-original",
    conversation: {
      channel: "demo",
      accountId: "a",
      conversationId: "topic",
      parentConversationId: "room",
    },
    targetSessionKey: "agent:main:fork",
    targetKind: "session",
    status: "active",
    boundAt: 100,
    expiresAt: 2000,
    metadata: { lastActivityAt: 110, nested: { value: "original" } },
  };
}

describe("real binding identity and route owner", () => {
  it("keeps activity out of routing identity but includes it in exact snapshot comparison", () => {
    const expected = record();
    const route = withConversationBindingRouteFacts(
      { sessionKey: expected.targetSessionKey, agentId: "main" },
      resolveConversationBindingSelection(expected),
      "main",
      expected.conversation,
    );
    const facts = readConversationBindingRouteFacts(route)!;
    const touched = { ...expected, metadata: { ...expected.metadata, lastActivityAt: 120 } };
    expect(matchesSessionBindingIdentity(expected, touched)).toBe(true);
    expect(matchesConversationBindingRouteFacts(facts, touched)).toBe(true);
    expect(matchesActiveSessionBindingSnapshot(expected, structuredClone(expected), 1000)).toBe(
      true,
    );
    expect(matchesActiveSessionBindingSnapshot(expected, touched, 1000)).toBe(false);
    expect(
      matchesSessionBindingIdentity(expected, {
        ...expected,
        generation: "generation-rebound",
      }),
    ).toBe(false);
    expect(
      matchesConversationBindingRouteFacts(facts, {
        ...expected,
        targetSessionKey: "agent:other:fork",
      }),
    ).toBe(false);
    for (const key of ["channel", "accountId", "conversationId", "parentConversationId"] as const) {
      expect(
        matchesConversationBindingRouteFacts(facts, {
          ...expected,
          conversation: { ...expected.conversation, [key]: "different" },
        }),
      ).toBe(false);
    }
    expect(matchesActiveSessionBindingSnapshot(expected, expected, 2000)).toBe(false);
    expect(matchesActiveSessionBindingSnapshot(expected, expected, Number.NaN)).toBe(false);
    expect(
      matchesActiveSessionBindingSnapshot(expected, { ...expected, status: "ending" }, 1000),
    ).toBe(false);
    expect(matchesActiveSessionBindingSnapshot(expected, null, 1000)).toBe(false);
  });

  it("retains plugin-root and observed-agent checks beyond binding identity", () => {
    const plugin = {
      ...record(),
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo",
        pluginRoot: "/synthetic/plugins/demo",
      },
    };
    const observe = (binding: SessionBindingRecord) =>
      readConversationBindingRouteFacts(
        withConversationBindingRouteFacts(
          { sessionKey: binding.targetSessionKey, agentId: "main" },
          resolveConversationBindingSelection(binding),
          "main",
          binding.conversation,
        ),
      )!;
    const facts = observe(plugin);
    expect(matchesConversationBindingRouteFacts(facts, structuredClone(plugin))).toBe(true);
    const moved = {
      ...plugin,
      metadata: { ...plugin.metadata, pluginRoot: "/synthetic/plugins/other" },
    };
    expect(matchesSessionBindingIdentity(plugin, moved)).toBe(true);
    expect(matchesConversationBindingRouteFacts(facts, moved)).toBe(false);
    const global = { ...record(), targetSessionKey: "global", metadata: { agentId: "main" } };
    const globalFacts = observe(global);
    expect(matchesConversationBindingRouteFacts(globalFacts, structuredClone(global))).toBe(true);
    const other = { ...global, metadata: { agentId: "other" } };
    expect(matchesSessionBindingIdentity(global, other)).toBe(true);
    expect(matchesConversationBindingRouteFacts(globalFacts, other)).toBe(false);
  });
});
