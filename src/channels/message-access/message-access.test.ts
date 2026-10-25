import { expect, it } from "vitest";
import { decideChannelIngress } from "./decision.js";
import { resolveChannelIngressState } from "./state.js";
import type { InternalChannelIngressAdapter } from "./types.js";

const adapter: InternalChannelIngressAdapter = {
  normalizeEntries: ({ entries }) => ({
    matchable: entries.map((value, index) => ({
      opaqueEntryId: `entry-${index}`,
      kind: "stable-id",
      value: value.toLowerCase(),
    })),
    invalid: [],
    disabled: [],
  }),
  matchSubject: ({ subject, entries }) => {
    const values = new Set(subject.identifiers.map(({ value }) => value.toLowerCase()));
    const matchedEntryIds = entries
      .filter(({ value }) => values.has(value))
      .map(({ opaqueEntryId }) => opaqueEntryId);
    return { matched: matchedEntryIds.length > 0, matchedEntryIds };
  },
};

it.each(["inbound", "origin-subject"] as const)(
  "preserves static authentication for legacy %s adapters without matched pairs",
  async (authMode) => {
    const state = await resolveChannelIngressState({
      channelId: "test",
      accountId: "default",
      adapter,
      subject: { identifiers: [{ opaqueId: "sender", kind: "stable-id", value: "SENDER" }] },
      conversation: { kind: "direct", id: "dm-1" },
      allowlists: { dm: ["sender"] },
      event: {
        kind: "message",
        authMode,
        mayPair: false,
        originSubject: {
          identifiers: [{ opaqueId: "sender", kind: "stable-id", value: "sender" }],
        },
      },
    });
    const policy = { dmPolicy: "allowlist", groupPolicy: "allowlist" } as const;
    expect(decideChannelIngress(state, policy).admission).toBe("dispatch");
    expect(
      decideChannelIngress(state, { ...policy, minIdentifierAuthentication: "verified" }).admission,
    ).toBe("drop");
  },
);

it("requires explicit group fallback to DM allowlists before runtime preprocessing", async () => {
  const state = await resolveChannelIngressState({
    channelId: "test",
    accountId: "default",
    subject: { identifiers: [{ opaqueId: "sender", kind: "stable-id", value: "sender-1" }] },
    conversation: { kind: "group", id: "room-1" },
    adapter,
    event: { kind: "message", authMode: "inbound", mayPair: true },
    allowlists: { dm: ["sender-1"] },
  });
  const policy = { dmPolicy: "pairing", groupPolicy: "allowlist" } as const;
  expect(decideChannelIngress(state, policy)).toMatchObject({
    admission: "drop",
    reasonCode: "group_policy_empty_allowlist",
  });
  expect(
    decideChannelIngress(state, { ...policy, groupAllowFromFallbackToAllowFrom: true }),
  ).toMatchObject({ admission: "dispatch", decision: "allow" });
});
