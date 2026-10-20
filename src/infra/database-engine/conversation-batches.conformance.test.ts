import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { buildConversationIdentity } from "../../config/sessions/conversation-identity.js";
import {
  listConversations,
  readConversation,
  registerConversationAddresses as registerAddresses,
} from "../../config/sessions/conversation-registry.js";
import {
  bindCurrentConversationRecordAsync as bind,
  listCurrentConversationBindingRecordsBySessionsAsync as listBindings,
  readCurrentConversationBindingSelectionAsync as selectBindings,
} from "../outbound/current-conversation-bindings.js";
import type { SessionBindingRecord } from "../outbound/session-binding.types.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "./mixed-agent.conformance.test-support.js";

describe
  .skipIf(!mixedAgentConnection)
  .each(mixedAgentPairs.filter(({ stateEngine, agentEngine }) => stateEngine === agentEngine))(
  "$agentEngine conversation batches",
  ({ stateEngine, agentEngine }) => {
    useMixedAgentPair(stateEngine, agentEngine);

    it("registers distinct addresses with each duplicate's final postimage", async () => {
      const addresses = ["first", "second"].map((id) => {
        const identity = buildConversationIdentity({
          channel: "demo",
          accountId: "default",
          kind: "direct",
          peerId: id,
          deliveryTarget: `demo:${id}`,
          label: id,
        });
        assert(identity);
        return identity;
      });
      const scope = { agentId: "main", env: process.env };
      await registerAddresses(
        scope,
        [...addresses, { ...addresses[0]!, label: "final first" }],
        100,
      );
      expect(await listConversations(scope, { channel: "demo" })).toHaveLength(2);
      for (const [index, identity] of addresses.entries()) {
        expect(await readConversation(scope, identity.conversationRef)).toMatchObject({
          conversationRef: identity.conversationRef,
          target: identity.deliveryTarget,
          label: index === 0 ? "final first" : "second",
          firstSeenAt: 100,
          lastSeenAt: 100,
        });
      }
    });

    it("selects and lists binding batches with absences, duplicates, and account scope", async () => {
      const records: SessionBindingRecord[] = ["first", "second"].map((id) => ({
        bindingId: id === "first" ? "generic:demo\u241fdefault\u241f\u241ffirst" : `fixture:${id}`,
        conversation: {
          channel: "demo",
          accountId: id === "first" ? "default" : "other",
          conversationId: id,
        },
        targetSessionKey: `agent:main:${id}`,
        targetKind: "session",
        status: "active",
        boundAt: 1,
        metadata: {},
      }));
      for (const record of records) {
        await bind({ record });
      }
      const [first, second] = records;
      assert(first && second);
      expect(
        await selectBindings([
          second.conversation,
          { ...first.conversation, conversationId: "missing" },
          first.conversation,
          second.conversation,
        ]),
      ).toEqual([second, null, first, second]);
      const targets = [
        second.targetSessionKey,
        "agent:main:missing",
        first.targetSessionKey,
        second.targetSessionKey,
      ];
      for (const [accountId, expected] of [
        [undefined, [[], [], [first], []]],
        ["default", [[], [], [first], []]],
        ["other", [[second], [], [], [second]]],
      ] as const) {
        expect(
          await listBindings(targets, accountId ? { channel: "demo", accountId } : undefined),
        ).toEqual(expected);
      }
    });
  },
);
