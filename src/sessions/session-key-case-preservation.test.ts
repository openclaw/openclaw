import { describe, expect, it } from "vitest";
import { resolveSessionStoreEntryCore } from "../config/sessions/store-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  normalizeSessionPeerId,
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

it("still preserves Signal group ids", () => {
  expect(normalizeSessionPeerId({ channel: "signal", peerKind: "group", peerId: "AbC123=" })).toBe(
    "AbC123=",
  );
});

it("keeps Matrix room id case in the channel session key (both prod rooms)", () => {
  expect(
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "matrix",
      peerKind: "channel",
      peerId: ROOM_A,
    }),
  ).toBe(`agent:main:matrix:channel:${ROOM_A}`);
  expect(
    buildAgentPeerSessionKey({
      agentId: "ops",
      channel: "matrix",
      peerKind: "channel",
      peerId: ROOM_B,
    }),
  ).toBe(`agent:ops:matrix:channel:${ROOM_B}`);
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

  it("preserves Matrix tails behind malformed nested ownership wrappers", () => {
    const key = `Agent:Voice:Agent::Matrix:Channel:${ROOM_A}:Thread:${EVENT}`;
    const normalized = `agent:voice:agent::matrix:channel:${ROOM_A}:thread:${EVENT}`;

    expect(normalizeSessionKeyPreservingOpaquePeerIds(key)).toBe(normalized);
    expect(requiresFoldedSessionKeyAliasProof(normalized)).toBe(true);
    expect(parseRawSessionConversationRef(normalized)).toBeNull();
  });

  it("preserves Matrix tails after an extra empty nested-wrapper segment", () => {
    const mixed = `Agent:Voice:Agent:Voice::Matrix:Channel:${ROOM_A}`;
    const lower = `agent:voice:agent:voice::matrix:channel:${ROOM_A.toLowerCase()}`;
    const normalized = `agent:voice:agent:voice::matrix:channel:${ROOM_A}`;

    expect(normalizeSessionKeyPreservingOpaquePeerIds(mixed)).toBe(normalized);
    expect(normalizeSessionKeyPreservingOpaquePeerIds(mixed)).not.toBe(
      normalizeSessionKeyPreservingOpaquePeerIds(lower),
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

  it("does NOT return a case-distinct sibling as `existing` when the exact mixed-case key is absent", () => {
    const r = resolveEntry(ROOM_LOWER_KEY, entry("room:!mixedroomabcdef:example.org", 999));
    expect(r.legacyKeys).not.toContain(ROOM_LOWER_KEY);
    expect(r.existing).toBeUndefined();
  });

  it("preserves a folded key with no delivery target and does not return it as `existing` (conservative)", () => {
    const r = resolveEntry(ROOM_LOWER_KEY, { updatedAt: 50 } as unknown as SessionEntry);
    expect(r.legacyKeys).not.toContain(ROOM_LOWER_KEY);
    expect(r.existing).toBeUndefined();
  });

  it("does not return an exact lowercase Matrix key whose delivery target is mixed-case", () => {
    const r = resolveEntry(ROOM_LOWER_KEY, entry(`room:${ROOM_A}`, 50), ROOM_LOWER_KEY);
    expect(r).toMatchObject({ legacyKeys: [], existing: undefined });
  });

  it("still returns + collapses a confirmed lowercased artifact as `existing` when no exact key exists", () => {
    const r = resolveEntry(ROOM_LOWER_KEY, entry(`room:${ROOM_A}`, 50));
    expect(r.legacyKeys).toContain(ROOM_LOWER_KEY);
    expect(deliveryContextFromSession(r.existing)?.to).toBe("room:!MixedRoomAbCdEf:example.org");
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

  it("collapses Matrix thread artifacts with legacy lowercased room and preserved event id", () => {
    const value = entry(`room:${ROOM_A}`, 50, "$ThreadRootAbC");
    const r = resolveEntry(ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY, value, ROOM_MIXED_THREAD_KEY);
    expect(r.legacyKeys).toContain(ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY);
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
});
