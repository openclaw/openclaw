import { expect, it } from "vitest";
import { decideChannelIngress } from "./decision.js";
import { resolveChannelIngressState } from "./state.js";
import type {
  ChannelIngressPolicyInput,
  ChannelIngressStateInput,
  InternalChannelIngressAdapter,
  InternalChannelIngressSubject,
} from "./types.js";

const subject = (value: string): InternalChannelIngressSubject => ({
  identifiers: [{ opaqueId: "subject-1", kind: "stable-id", value }],
});

function makeAdapter(foldCase = false): InternalChannelIngressAdapter {
  const normalize = (value: string) => (foldCase ? value.toLowerCase() : value);
  return {
    normalizeEntries: ({ entries }) => ({
      matchable: entries.map((entry, index) => ({
        opaqueEntryId: `entry-${index + 1}`,
        kind: "stable-id",
        value: normalize(entry),
        ...(foldCase ? {} : { dangerous: entry.startsWith("display:") }),
      })),
      invalid: [],
      disabled: [],
    }),
    matchSubject({ subject: candidate, entries }) {
      const values = new Set(candidate.identifiers.map(({ value }) => normalize(value)));
      const matchedEntryIds = entries
        .filter((entry) =>
          foldCase
            ? entry.kind === "stable-id" && values.has(entry.value)
            : entry.value === "*" || values.has(entry.value),
        )
        .map(({ opaqueEntryId }) => opaqueEntryId);
      return { matched: matchedEntryIds.length > 0, matchedEntryIds };
    },
  };
}
const adapter = makeAdapter();
const lowerCaseAdapter = makeAdapter(true);

function resolveState(overrides: Partial<ChannelIngressStateInput> = {}) {
  return resolveChannelIngressState({
    channelId: "test",
    accountId: "default",
    subject: subject("sender-1"),
    conversation: { kind: "direct", id: "dm-1" },
    adapter,
    event: { kind: "message", authMode: "inbound", mayPair: true },
    allowlists: {},
    ...overrides,
  });
}

const routeFact = (senderPolicy: "replace" | "deny-when-empty", senderAllowFrom: string[]) => ({
  id: "space-1",
  kind: "route" as const,
  gate: "matched" as const,
  effect: "allow" as const,
  precedence: 0,
  senderPolicy,
  senderAllowFrom,
});

const policy: ChannelIngressPolicyInput = {
  dmPolicy: "pairing",
  groupPolicy: "allowlist",
};

it.each([
  {
    name: "keeps pairing-store entries DM-policy scoped",
    input: { subject: subject("paired-sender"), allowlists: { pairingStore: ["paired-sender"] } },
    blocked: { dmPolicy: "open" as const },
    enabled: {},
    reason: "dm_policy_not_allowlisted",
  },
  {
    name: "requires explicit group fallback to DM allowlists",
    input: {
      conversation: { kind: "group" as const, id: "room-1" },
      allowlists: { dm: ["sender-1"] },
    },
    blocked: {},
    enabled: { groupAllowFromFallbackToAllowFrom: true },
    reason: "group_policy_empty_allowlist",
  },
  {
    name: "requires explicit dangerous identifier matching",
    input: { subject: subject("display:sender-1"), allowlists: { dm: ["display:sender-1"] } },
    blocked: { dmPolicy: "allowlist" as const },
    enabled: { dmPolicy: "allowlist" as const, mutableIdentifierMatching: "enabled" as const },
    reason: "dm_policy_not_allowlisted",
  },
])("$name", async ({ input, blocked, enabled, reason }) => {
  const state = await resolveState(input);
  expect(decideChannelIngress(state, { ...policy, ...blocked })).toMatchObject({
    admission: "drop",
    reasonCode: reason,
  });
  expect(decideChannelIngress(state, { ...policy, ...enabled })).toMatchObject({
    admission: "dispatch",
    decision: "allow",
  });
});

it("applies route sender allowlists without retaining raw sender values", async () => {
  const rawSender = "route-sender@example.test";
  const state = await resolveState({
    subject: subject(rawSender),
    conversation: { kind: "group", id: "room-1" },
    routeFacts: [routeFact("replace", [rawSender])],
    allowlists: { group: ["group-sender"] },
  });

  const decision = decideChannelIngress(state, policy);

  expect(state.routeFacts[0]?.senderAllowlist).toMatchObject({
    hasConfiguredEntries: true,
    match: { matched: true },
  });
  expect(decision).toMatchObject({ admission: "dispatch", decision: "allow" });
  expect(JSON.stringify(state)).not.toContain(rawSender);
  expect(JSON.stringify(decision)).not.toContain(rawSender);
});

it("blocks matched routes with deny-when-empty sender policy", async () => {
  const state = await resolveState({
    routeFacts: [routeFact("deny-when-empty", [])],
    allowlists: { dm: ["sender-1"] },
  });

  expect(decideChannelIngress(state, policy)).toMatchObject({
    admission: "drop",
    reasonCode: "route_sender_empty",
  });
  expect(state.routeFacts[0]).not.toHaveProperty("senderAllowFrom");
});

it("translates implicit mention config before shared activation evaluation", async () => {
  const state = await resolveState({
    conversation: { kind: "group", id: "room-1" },
    mentionFacts: {
      canDetectMention: true,
      wasMentioned: false,
      implicitMentionKinds: ["reply_to_bot", "bot_thread_participant"],
    },
    allowlists: { group: ["sender-1"] },
  });
  const decision = decideChannelIngress(state, {
    ...policy,
    activation: {
      requireMention: true,
      allowTextCommands: false,
      implicitMentions: {
        replyToBot: false,
        quotedBot: true,
        threadParticipation: true,
      },
    },
  });

  expect(decision).toMatchObject({ admission: "dispatch", decision: "allow" });
  const activation = decision.graph.gates.find((gate) => gate.phase === "activation")?.activation;
  expect(activation).toMatchObject({
    allowedImplicitMentionKinds: ["quoted_bot", "bot_thread_participant", "native"],
    effectiveWasMentioned: true,
  });
});

it.each([
  ["matches the same origin actor", "sender-1", "sender-1", false, true],
  ["rejects different origin actors", "sender-1", "different-sender", false, false],
  ["uses adapter-normalized identity values", "Sender-1", "sender-1", true, true],
] as const)("%s", async (_name, current, origin, foldCase, matched) => {
  const state = await resolveState({
    adapter: foldCase ? lowerCaseAdapter : adapter,
    subject: subject(current),
    event: {
      kind: "reaction",
      authMode: "origin-subject",
      mayPair: false,
      originSubject: subject(origin),
    },
  });
  const decision = decideChannelIngress(state, policy);

  expect(state.event.originSubjectMatched).toBe(matched);
  expect(decision).toMatchObject(
    matched
      ? { admission: "dispatch", decision: "allow" }
      : { admission: "drop", decision: "block", reasonCode: "origin_subject_not_matched" },
  );
  if (matched) {
    const gate = decision.graph.gates.find(
      (gateLocal) => gateLocal.phase === "sender" && gateLocal.kind === "dmSender",
    );
    expect(gate).toMatchObject({
      effect: "ignore",
      reasonCode: "sender_not_required",
    });
  }
});
