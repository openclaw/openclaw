import { describe, expect, it } from "vitest";
import { resolveSessionStoreEntryCore } from "../config/sessions/store-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseRawSessionConversationRef,
  requiresFoldedSessionKeyAliasProof,
} from "./session-key-utils.js";

const ROOM_MIXED_KEY = "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org";
const ROOM_LOWER_KEY = "agent:main:matrix:channel:!mixedroomabcdef:example.org";
const ROOM_MIXED_THREAD_KEY = `${ROOM_MIXED_KEY}:thread:$ThreadRootAbC`;
const ROOM_LOWER_THREAD_KEY = `${ROOM_LOWER_KEY}:thread:$threadrootabc`;
const ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY = `${ROOM_LOWER_KEY}:thread:$ThreadRootAbC`;
const entry = (to: string, updatedAt: number, threadId?: string): SessionEntry => ({
  sessionId: `session-${updatedAt}`,
  updatedAt,
  delivery: normalizeSessionDeliveryState({ context: { channel: "matrix", to, threadId } }),
});

// Regressions: #75670 (Matrix room IDs), #82853 (Signal groups), #87366 (aliases).
const ROOM_A = "!MixedRoomAbCdEf:example.org";
const ROOM_B = "!OtherRoomGhIjKl:matrix.example.org";
const EVENT = "$EvMixedCaseAbCdEfGhIjKlMnOpQrStUvWxYz0";

function resolveEntry(key: string, value: SessionEntry, sessionKey = ROOM_MIXED_KEY) {
  return resolveSessionStoreEntryCore({ store: { [key]: value }, sessionKey });
}

describe("parseRawSessionConversationRef", () => {
  it("preserves empty segments inside opaque Matrix room ids", () => {
    expect(parseRawSessionConversationRef("agent:main:matrix:channel:!room:[2001:db8::1]")).toEqual(
      {
        channel: "matrix",
        kind: "channel",
        rawId: "!room:[2001:db8::1]",
        prefix: "agent:main:matrix:channel",
      },
    );
  });

  it.each([
    "agent::matrix:channel:room",
    "agent:voice:matrix::room",
    "agent:voice:matrix:channel::room",
  ])("rejects empty structural segments in %s", (sessionKey) => {
    expect(parseRawSessionConversationRef(sessionKey)).toBeNull();
  });
});

it("keeps Matrix room id case in the channel session key (both prod rooms)", () => {
  for (const [agentId, peerId] of [
    ["main", ROOM_A],
    ["ops", ROOM_B],
  ] as const) {
    expect(
      buildAgentPeerSessionKey({ agentId, channel: "matrix", peerKind: "channel", peerId }),
    ).toBe(`agent:${agentId}:matrix:channel:${peerId}`);
  }
});

describe("normalizeSessionKeyPreservingOpaquePeerIds (store canonicalization)", () => {
  it("preserves Matrix Signal-shaped segments inside room and event ids", () => {
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds(
        `Agent:Main:Matrix:Channel:${ROOM_A}:Signal:Group: AbC :Thread:${EVENT}:Signal:Group: XyZ :End`,
      ),
    ).toBe(
      `agent:main:matrix:channel:${ROOM_A}:Signal:Group: AbC :thread:${EVENT}:Signal:Group: XyZ :End`,
    );
  });

  it.each([
    ["Agent:Voice:Agent:", `:Thread:${EVENT}`],
    ["Agent:Voice:Agent:Voice:", ""],
  ])("preserves opaque tails after malformed wrapper %s", (prefix, suffix) => {
    const mixed = `${prefix}:Matrix:Channel:${ROOM_A}${suffix}`;
    const normalized = `${prefix.toLowerCase()}:matrix:channel:${ROOM_A}${suffix.replace(":Thread:", ":thread:")}`;
    expect(normalizeSessionKeyPreservingOpaquePeerIds(mixed)).toBe(normalized);
    expect(normalizeSessionKeyPreservingOpaquePeerIds(mixed)).not.toBe(
      normalizeSessionKeyPreservingOpaquePeerIds(mixed.toLowerCase()),
    );
    expect(requiresFoldedSessionKeyAliasProof(normalized)).toBe(true);
    expect(parseRawSessionConversationRef(normalized)).toBeNull();
  });

  it("preserves Signal group id segments", () => {
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds(
        "Signal:Group: AbC123= :Signal:Group: XyZ987= :THREAD:Mixed",
      ),
    ).toBe("signal:group:AbC123=:signal:group:XyZ987=:thread:mixed");
  });
});

describe("resolveSessionStoreEntry — case-distinct Matrix session safety (codex #87366 P2)", () => {
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
  ] as const)("rejects an unproven alias with %s", (_label, value, sessionKey) => {
    const resolved = resolveEntry(ROOM_LOWER_KEY, value, sessionKey);
    expect(resolved.legacyKeys).toEqual([]);
    expect(resolved.existing).toBeUndefined();
  });

  it("does not collapse Matrix thread artifacts when the stored thread id differs by case", () => {
    const r = resolveEntry(
      ROOM_LOWER_THREAD_KEY,
      entry(`room:${ROOM_A}`, 50, "$threadrootabc"),
      ROOM_MIXED_THREAD_KEY,
    );
    expect(r.legacyKeys).not.toContain(ROOM_LOWER_THREAD_KEY);
    expect(r.existing).toBeUndefined();
  });

  it.each([
    [ROOM_LOWER_KEY, ROOM_MIXED_KEY, undefined],
    [ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY, ROOM_MIXED_THREAD_KEY, "$ThreadRootAbC"],
  ] as const)("collapses the delivery-proven alias %s", (key, sessionKey, threadId) => {
    const value = entry(`room:${ROOM_A}`, 50, threadId);
    const r = resolveEntry(key, value, sessionKey);
    expect(r.legacyKeys).toContain(key);
    expect(r.existing).toBe(value);
    expect(deliveryContextFromSession(r.existing)?.to).toBe(`room:${ROOM_A}`);
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
});
