import { expect, it } from "vitest";
import { resolveSessionStoreEntryCore } from "../config/sessions/store-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  normalizeSessionKeyPreservingOpaquePeerIds as normalize,
  parseRawSessionConversationRef as parse,
  requiresFoldedSessionKeyAliasProof,
} from "./session-key-utils.js";

const ROOM_MIXED_KEY = "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org";
const ROOM_LOWER_KEY = ROOM_MIXED_KEY.toLowerCase();
const ROOM_MIXED_THREAD_KEY = `${ROOM_MIXED_KEY}:thread:$ThreadRootAbC`;
const ROOM_LOWER_THREAD_KEY = ROOM_MIXED_THREAD_KEY.toLowerCase();
const ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY = `${ROOM_LOWER_KEY}:thread:$ThreadRootAbC`;
const entry = (to: string, updatedAt: number, threadId?: string): SessionEntry => ({
  sessionId: `session-${updatedAt}`,
  updatedAt,
  delivery: normalizeSessionDeliveryState({ context: { channel: "matrix", to, threadId } }),
});

// Regressions: #75670 (Matrix room IDs), #82853 (Signal groups), #87366 (aliases).
const ROOM_A = "!MixedRoomAbCdEf:example.org";
const EVENT = "$EvMixedCaseAbCdEfGhIjKlMnOpQrStUvWxYz0";

function resolveEntry(key: string, value: SessionEntry, sessionKey = ROOM_MIXED_KEY) {
  return resolveSessionStoreEntryCore({ store: { [key]: value }, sessionKey });
}

it("preserves empty segments inside opaque Matrix room ids", () => {
  expect(parse("agent:main:matrix:channel:!room:[2001:db8::1]")).toEqual({
    channel: "matrix",
    kind: "channel",
    rawId: "!room:[2001:db8::1]",
    prefix: "agent:main:matrix:channel",
  });
});

it.each([
  "agent::matrix:channel:room",
  "agent:voice:matrix::room",
  "agent:voice:matrix:channel::room",
])("rejects empty structural segments in %s", (sessionKey) => {
  expect(parse(sessionKey)).toBeNull();
});

it("keeps Matrix room id case in the channel session key", () => {
  expect(
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "matrix",
      peerKind: "channel",
      peerId: ROOM_A,
    }),
  ).toBe(ROOM_MIXED_KEY);
});

it.each([
  [
    `Agent:Main:Matrix:Channel:${ROOM_A}:Signal:Group: AbC :Thread:${EVENT}:Signal:Group: XyZ :End`,
    `agent:main:matrix:channel:${ROOM_A}:Signal:Group: AbC :thread:${EVENT}:Signal:Group: XyZ :End`,
  ],
  [
    "Signal:Group: AbC123= :Signal:Group: XyZ987= :THREAD:Mixed",
    "signal:group:AbC123=:signal:group:XyZ987=:thread:mixed",
  ],
])("normalizes structure but preserves opaque segments: %s", (input, expected) => {
  expect(normalize(input)).toBe(expected);
});

it.each([
  ["Agent:Voice:Agent:", `:Thread:${EVENT}`],
  ["Agent:Voice:Agent:Voice:", ""],
])("preserves opaque tails after malformed wrapper %s", (prefix, suffix) => {
  const mixed = `${prefix}:Matrix:Channel:${ROOM_A}${suffix}`;
  const normalized = `${prefix.toLowerCase()}:matrix:channel:${ROOM_A}${suffix.replace(":Thread:", ":thread:")}`;
  expect(normalize(mixed)).toBe(normalized);
  expect(normalize(mixed)).not.toBe(normalize(mixed.toLowerCase()));
  expect(requiresFoldedSessionKeyAliasProof(normalized)).toBe(true);
  expect(parse(normalized)).toBeNull();
});
it("does NOT collapse a case-distinct sibling room (different real room, not an alias)", () => {
  const store: Record<string, SessionEntry> = {
    [ROOM_MIXED_KEY]: entry("room:!MixedRoomAbCdEf:example.org", 100),
    [ROOM_LOWER_KEY]: entry("room:!mixedroomabcdef:example.org", 999), // distinct + fresher
  };
  const r = resolveSessionStoreEntryCore({ store, sessionKey: ROOM_MIXED_KEY });
  expect(r).toMatchObject({ normalizedKey: ROOM_MIXED_KEY, legacyKeys: [] });
  expect(deliveryContextFromSession(r.existing)?.to).toBe("room:!MixedRoomAbCdEf:example.org");
});

it.each([
  ["case-distinct room", entry(`room:${ROOM_A.toLowerCase()}`, 999), ROOM_MIXED_KEY],
  ["missing delivery", { updatedAt: 50 } as unknown as SessionEntry, ROOM_MIXED_KEY],
  ["mismatched exact key", entry(`room:${ROOM_A}`, 50), ROOM_LOWER_KEY],
  ["case-distinct thread", entry(`room:${ROOM_A}`, 50, "$threadrootabc"), ROOM_MIXED_THREAD_KEY],
] as const)("rejects an unproven alias with %s", (_label, value, sessionKey) => {
  const key = sessionKey === ROOM_MIXED_THREAD_KEY ? ROOM_LOWER_THREAD_KEY : ROOM_LOWER_KEY;
  const resolved = resolveEntry(key, value, sessionKey);
  expect(resolved.legacyKeys).toEqual([]);
  expect(resolved.existing).toBeUndefined();
});

it.each([
  [ROOM_LOWER_KEY, ROOM_MIXED_KEY, undefined],
  [ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY, ROOM_MIXED_THREAD_KEY, "$ThreadRootAbC"],
] as const)("collapses the delivery-proven alias %s", (key, sessionKey, threadId) => {
  const value = entry(`room:${ROOM_A}`, 50, threadId);
  const r = resolveEntry(key, value, sessionKey);
  expect(r.legacyKeys).toContain(key);
  expect(r.existing).toBe(value);
});

it("keeps freshest legacy lowercase Signal group aliases", () => {
  const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
  const mixedKey = `agent:main:signal:group:${mixedGroupId}`;
  const lowerKey = mixedKey.toLowerCase();
  const staleCanonical: SessionEntry = { sessionId: "stale-signal-canonical", updatedAt: 100 };
  const freshLegacy: SessionEntry = { sessionId: "fresh-signal-legacy", updatedAt: 200 };
  const store: Record<string, SessionEntry> = {
    [mixedKey]: staleCanonical,
    [lowerKey]: freshLegacy,
  };

  const r = resolveSessionStoreEntryCore({ store, sessionKey: mixedKey });

  expect(r.legacyKeys).toContain(lowerKey);
  expect(r.existing).toBe(freshLegacy);
});
