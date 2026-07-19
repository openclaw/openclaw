// Session key case tests cover preserving meaningful case in session keys.
import { describe, expect, it } from "vitest";
import {
  resolveSessionEntryCandidates,
  resolveSessionStoreEntry,
} from "../config/sessions/store-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { SessionSchema } from "../config/zod-schema.session.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
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
const entry = (to: string, updatedAt: number): SessionEntry =>
  ({ updatedAt, deliveryContext: { channel: "matrix", to } }) as unknown as SessionEntry;

// Regression matrix for the generic opt-in case-preservation registry
// (openclaw/openclaw#75670 — Matrix room ids; #82853 — Signal groups).
// Synthetic mixed-case opaque IDs: a room id with an embedded ":server" and a
// case-sensitive thread event id, mirroring the Matrix spec.
const ROOM_A = "!MixedRoomAbCdEf:example.org";
const ROOM_B = "!OtherRoomGhIjKl:matrix.example.org";
const EVENT = "$EvMixedCaseAbCdEfGhIjKlMnOpQrStUvWxYz0";

describe("requiresFoldedSessionKeyAliasProof", () => {
  it("requires alias proof only for tail-preserved Matrix room keys", () => {
    expect(requiresFoldedSessionKeyAliasProof(`agent:main:matrix:channel:${ROOM_A}`)).toBe(true);
    expect(requiresFoldedSessionKeyAliasProof("agent:ops:signal:group:AbC123=")).toBe(false);
    expect(requiresFoldedSessionKeyAliasProof("agent:main:telegram:group:MixedHandle")).toBe(false);
  });

  it("recognizes nested Matrix identities without trusting them as channel routes", () => {
    const opaqueKey = `agent:voice:agent:other:matrix:channel:${ROOM_A}`;

    expect(requiresFoldedSessionKeyAliasProof(opaqueKey)).toBe(true);
    expect(parseRawSessionConversationRef(opaqueKey)).toBeNull();
  });
});

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
    "agent:voice::matrix:channel:room",
    "agent:voice:agent:channel:room",
    "agent:voice:matrix::room",
    "agent:voice:matrix:channel::room",
  ])("rejects empty structural segments in %s", (sessionKey) => {
    expect(parseRawSessionConversationRef(sessionKey)).toBeNull();
  });
});

describe("normalizeSessionPeerId (construction)", () => {
  it("preserves Matrix room ids for channel/group peers", () => {
    expect(normalizeSessionPeerId({ channel: "matrix", peerKind: "channel", peerId: ROOM_A })).toBe(
      ROOM_A,
    );
    expect(normalizeSessionPeerId({ channel: "matrix", peerKind: "group", peerId: ROOM_B })).toBe(
      ROOM_B,
    );
  });

  it("lowercases non-enrolled channels", () => {
    expect(
      normalizeSessionPeerId({ channel: "telegram", peerKind: "group", peerId: "MixedHandle" }),
    ).toBe("mixedhandle");
    expect(
      normalizeSessionPeerId({ channel: "telegram", peerKind: "direct", peerId: "MixedHandle" }),
    ).toBe("mixedhandle");
  });

  it("preserves Matrix DM (direct) MXID case", () => {
    expect(
      normalizeSessionPeerId({ channel: "matrix", peerKind: "direct", peerId: "@Bob:X" }),
    ).toBe("@Bob:X");
  });

  it("still preserves Signal group ids", () => {
    expect(
      normalizeSessionPeerId({ channel: "signal", peerKind: "group", peerId: "AbC123=" }),
    ).toBe("AbC123=");
  });
});

describe("buildAgentPeerSessionKey (construction, full key)", () => {
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

  it("does not collapse two case-distinct rooms to one key", () => {
    const a = buildAgentPeerSessionKey({
      agentId: "x",
      channel: "matrix",
      peerKind: "channel",
      peerId: ROOM_A,
    });
    const b = buildAgentPeerSessionKey({
      agentId: "x",
      channel: "matrix",
      peerKind: "channel",
      peerId: ROOM_A.toLowerCase(),
    });
    expect(a).not.toBe(b);
  });
});

describe("normalizeSessionKeyPreservingOpaquePeerIds (store canonicalization)", () => {
  it("preserves the Matrix room id (embedded :server) in a channel key", () => {
    expect(normalizeSessionKeyPreservingOpaquePeerIds(`agent:main:matrix:channel:${ROOM_A}`)).toBe(
      `agent:main:matrix:channel:${ROOM_A}`,
    );
  });

  it("preserves the Matrix room id AND the :thread:<event> suffix", () => {
    const key = `agent:main:matrix:channel:${ROOM_A}:thread:${EVENT}`;
    expect(normalizeSessionKeyPreservingOpaquePeerIds(key)).toBe(key);
  });

  it("lowercases the Matrix thread marker while preserving room and event ids", () => {
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds(
        `agent:main:matrix:channel:${ROOM_A}:Thread:${EVENT}`,
      ),
    ).toBe(`agent:main:matrix:channel:${ROOM_A}:thread:${EVENT}`);
  });

  it("lowercases the structural head but keeps the opaque tail", () => {
    expect(normalizeSessionKeyPreservingOpaquePeerIds(`Agent:Main:Matrix:Channel:${ROOM_A}`)).toBe(
      `agent:main:matrix:channel:${ROOM_A}`,
    );
  });

  it("preserves Matrix tails under nested agent ownership wrappers", () => {
    const key = `Agent:Voice:Agent:Other:Matrix:Channel:${ROOM_A}:Thread:${EVENT}`;
    const normalized = `agent:voice:agent:other:matrix:channel:${ROOM_A}:thread:${EVENT}`;
    expect(normalizeSessionKeyPreservingOpaquePeerIds(key)).toBe(normalized);
    expect(requiresFoldedSessionKeyAliasProof(normalized)).toBe(true);
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

  it("preserves unscoped Matrix room and thread ids before agent scoping", () => {
    expect(normalizeSessionKeyPreservingOpaquePeerIds(`Matrix:Channel:${ROOM_A}`)).toBe(
      `matrix:channel:${ROOM_A}`,
    );
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds(`Matrix:Channel:${ROOM_A}:Thread:${EVENT}`),
    ).toBe(`matrix:channel:${ROOM_A}:thread:${EVENT}`);
  });

  it("preserves Matrix DM (direct) MXID case in channel-scoped keys", () => {
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds("agent:main:matrix:direct:@Bob:Example.Org"),
    ).toBe("agent:main:matrix:direct:@Bob:Example.Org");
  });

  it("preserves Matrix DM (direct) MXID case behind an account segment", () => {
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds("agent:main:matrix:Acct1:direct:@Bob:Example.Org"),
    ).toBe("agent:main:matrix:acct1:direct:@Bob:Example.Org");
  });

  it("folds channel-agnostic per-peer DM keys, which carry no channel to enroll", () => {
    expect(normalizeSessionKeyPreservingOpaquePeerIds("agent:main:direct:@Bob:Example.Org")).toBe(
      "agent:main:direct:@bob:example.org",
    );
  });

  it("keeps Signal DM (direct) peers folded, not enrolled by this change", () => {
    expect(normalizeSessionKeyPreservingOpaquePeerIds("agent:ops:signal:direct:+15550001")).toBe(
      "agent:ops:signal:direct:+15550001",
    );
    expect(normalizeSessionPeerId({ channel: "signal", peerKind: "direct", peerId: "AbC" })).toBe(
      "abc",
    );
  });

  it("preserves Signal group id segment (scoped and unscoped), unchanged behavior", () => {
    expect(normalizeSessionKeyPreservingOpaquePeerIds("agent:ops:signal:group:AbC123=")).toBe(
      "agent:ops:signal:group:AbC123=",
    );
    // Unscoped (no agent: head) still preserved, matching prior behavior.
    expect(normalizeSessionKeyPreservingOpaquePeerIds("Signal:Group:AbC123=")).toBe(
      "signal:group:AbC123=",
    );
  });

  it("keeps lowercasing a Signal thread suffix (segment span, not tail)", () => {
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds("agent:ops:signal:group:AbC123=:thread:XyZ"),
    ).toBe("agent:ops:signal:group:AbC123=:thread:xyz");
  });

  it("trims whitespace inside a preserved Signal segment (matches legacy behavior)", () => {
    // Malformed key edge: the legacy peerId.trim() path trimmed the segment; keep parity.
    expect(normalizeSessionKeyPreservingOpaquePeerIds("agent:ops:signal:group: AbC123= ")).toBe(
      "agent:ops:signal:group:AbC123=",
    );
  });

  it("does NOT preserve non-enrolled channels, even with a :thread:-shaped peer id", () => {
    // qa-channel-style peer id literally containing ':thread:' must stay lowercased.
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds("agent:main:qa:channel:thread:QA-Room/Thread-1"),
    ).toBe("agent:main:qa:channel:thread:qa-room/thread-1");
    // Explicit Slack channel key with a thread suffix stays lowercased.
    expect(
      normalizeSessionKeyPreservingOpaquePeerIds("agent:main:slack:channel:C1:thread:ABC"),
    ).toBe("agent:main:slack:channel:c1:thread:abc");
  });

  // KNOWN RESIDUAL (documented follow-up): a thread key built off a `main` base has no
  // <channel>:<peerKind>: boundary, so store-canon cannot identify the owning channel
  // from the key and still lowercases the event. Construction preserves it; this is the
  // main-session thread shape, not the room-session shape behind #75670.
  it("KNOWN RESIDUAL: lowercases a main-base thread event (no channel boundary)", () => {
    expect(normalizeSessionKeyPreservingOpaquePeerIds(`agent:main:main:thread:${EVENT}`)).toBe(
      `agent:main:main:thread:${EVENT}`.toLowerCase(),
    );
  });
});

describe("resolveSessionStoreEntry — case-distinct Matrix session safety (codex #87366 P2)", () => {
  it("returns the selected persisted key when resolving candidate rows", () => {
    const staleExact = entry("room:!MixedRoomAbCdEf:example.org", 100);
    const freshStructuralAlias = entry("room:!MixedRoomAbCdEf:example.org", 200);
    const structuralAliasKey = "Agent:Main:Matrix:Channel:!MixedRoomAbCdEf:example.org";

    const resolved = resolveSessionEntryCandidates({
      entries: [
        { sessionKey: ROOM_MIXED_KEY, entry: staleExact },
        { sessionKey: structuralAliasKey, entry: freshStructuralAlias },
      ],
      sessionKey: ROOM_MIXED_KEY,
    });

    expect(resolved.existing).toEqual({
      sessionKey: structuralAliasKey,
      entry: freshStructuralAlias,
    });
    expect(resolved.legacyKeys).toContain(structuralAliasKey);
  });

  it("does NOT collapse a case-distinct sibling room (different real room, not an alias)", () => {
    // Two genuinely distinct Matrix rooms whose ids differ only by case; each
    // delivers to its OWN id. Resolving one must not mark the other for deletion.
    const store: Record<string, SessionEntry> = {
      [ROOM_MIXED_KEY]: entry("room:!MixedRoomAbCdEf:example.org", 100),
      [ROOM_LOWER_KEY]: entry("room:!mixedroomabcdef:example.org", 999), // distinct + fresher
    };
    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_KEY });
    expect(r.normalizedKey).toBe(ROOM_MIXED_KEY);
    expect(r.legacyKeys).not.toContain(ROOM_LOWER_KEY);
    expect(r.legacyKeys).toEqual([]);
    // exact mixed-case entry wins over the fresher distinct sibling
    expect(r.existing?.deliveryContext?.to).toBe("room:!MixedRoomAbCdEf:example.org");
  });

  it("keeps fresher Matrix aliases that normalize to the same opaque key", () => {
    const staleExact = entry("room:!MixedRoomAbCdEf:example.org", 100);
    const freshStructuralAlias = entry("room:!MixedRoomAbCdEf:example.org", 200);
    const structuralAliasKey = "Agent:Main:Matrix:Channel:!MixedRoomAbCdEf:example.org";
    const store: Record<string, SessionEntry> = {
      [ROOM_MIXED_KEY]: staleExact,
      [structuralAliasKey]: freshStructuralAlias,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_KEY });

    expect(r.legacyKeys).toContain(structuralAliasKey);
    expect(r.existing).toBe(freshStructuralAlias);
  });

  it("does NOT return a case-distinct sibling as `existing` when the exact mixed-case key is absent", () => {
    // codex #87366 follow-up: the read fallback must also be gated, not just the
    // delete set — a distinct lowercase room must not leak into the mixed-case lookup.
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_KEY]: entry("room:!mixedroomabcdef:example.org", 999), // distinct room, its own id
    };
    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_KEY });
    expect(r.legacyKeys).not.toContain(ROOM_LOWER_KEY);
    expect(r.existing).toBeUndefined();
  });

  it("DOES collapse a lowercased legacy artifact (key lowercased but delivers to the real mixed-case room)", () => {
    // Legacy bug artifact: key was lowercased, but deliveryContext kept the real id.
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_KEY]: entry("room:!MixedRoomAbCdEf:example.org", 50),
    };
    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_KEY });
    expect(r.normalizedKey).toBe(ROOM_MIXED_KEY);
    expect(r.legacyKeys).toContain(ROOM_LOWER_KEY);
  });

  it("preserves a folded key with no delivery target and does not return it as `existing` (conservative)", () => {
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_KEY]: { updatedAt: 50 } as unknown as SessionEntry, // no deliveryContext
    };
    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_KEY });
    expect(r.legacyKeys).not.toContain(ROOM_LOWER_KEY);
    expect(r.existing).toBeUndefined();
  });

  it("does not return an exact lowercase Matrix key whose delivery target is mixed-case", () => {
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_KEY]: entry("room:!MixedRoomAbCdEf:example.org", 50),
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_LOWER_KEY });

    expect(r.legacyKeys).toEqual([]);
    expect(r.existing).toBeUndefined();
  });

  it("still returns + collapses a confirmed lowercased artifact as `existing` when no exact key exists", () => {
    // Legitimate migration read: artifact key is lowercased but delivers to the
    // mixed-case room, so it IS this room's session.
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_KEY]: entry("room:!MixedRoomAbCdEf:example.org", 50),
    };
    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_KEY });
    expect(r.legacyKeys).toContain(ROOM_LOWER_KEY);
    expect(r.existing?.deliveryContext?.to).toBe("room:!MixedRoomAbCdEf:example.org");
  });

  it("recognizes lowercased Matrix artifacts with inbound origin room metadata", () => {
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_KEY]: {
        updatedAt: 50,
        origin: {
          provider: "matrix",
          nativeChannelId: "!MixedRoomAbCdEf:example.org",
        },
      } as unknown as SessionEntry,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_KEY });

    expect(r.legacyKeys).toContain(ROOM_LOWER_KEY);
    expect(r.existing).toBe(store[ROOM_LOWER_KEY]);
  });

  it("recognizes lowercased Matrix alias artifacts with room-prefixed delivery targets", () => {
    const mixedAliasKey = "agent:main:matrix:channel:#MixedRoomAlias:example.org";
    const lowerAliasKey = "agent:main:matrix:channel:#mixedroomalias:example.org";
    const store: Record<string, SessionEntry> = {
      [lowerAliasKey]: {
        updatedAt: 50,
        deliveryContext: {
          channel: "matrix",
          to: "room:#MixedRoomAlias:example.org",
        },
      } as unknown as SessionEntry,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: mixedAliasKey });

    expect(r.legacyKeys).toContain(lowerAliasKey);
    expect(r.existing).toBe(store[lowerAliasKey]);
  });

  it("does not collapse Matrix thread artifacts when the stored thread id differs by case", () => {
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_THREAD_KEY]: {
        updatedAt: 50,
        deliveryContext: {
          channel: "matrix",
          to: "room:!MixedRoomAbCdEf:example.org",
          threadId: "$threadrootabc",
        },
      } as unknown as SessionEntry,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_THREAD_KEY });

    expect(r.legacyKeys).not.toContain(ROOM_LOWER_THREAD_KEY);
    expect(r.existing).toBeUndefined();
  });

  it("collapses Matrix thread artifacts when room and thread metadata both match", () => {
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_THREAD_KEY]: {
        updatedAt: 50,
        deliveryContext: {
          channel: "matrix",
          to: "room:!MixedRoomAbCdEf:example.org",
          threadId: "$ThreadRootAbC",
        },
      } as unknown as SessionEntry,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_THREAD_KEY });

    expect(r.legacyKeys).toContain(ROOM_LOWER_THREAD_KEY);
    expect(r.existing).toBe(store[ROOM_LOWER_THREAD_KEY]);
  });

  it("collapses Matrix thread artifacts with legacy lowercased room and preserved event id", () => {
    const store: Record<string, SessionEntry> = {
      [ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY]: {
        updatedAt: 50,
        deliveryContext: {
          channel: "matrix",
          to: "room:!MixedRoomAbCdEf:example.org",
          threadId: "$ThreadRootAbC",
        },
      } as unknown as SessionEntry,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: ROOM_MIXED_THREAD_KEY });

    expect(r.legacyKeys).toContain(ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY);
    expect(r.existing).toBe(store[ROOM_LOWER_ROOM_PRESERVED_THREAD_KEY]);
  });

  it("keeps legacy lowercase Signal group fallback without delivery metadata", () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const mixedKey = `agent:main:signal:group:${mixedGroupId}`;
    const lowerKey = mixedKey.toLowerCase();
    const signalEntry = { sessionId: "signal-session" } as unknown as SessionEntry;
    const store: Record<string, SessionEntry> = {
      [lowerKey]: signalEntry,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: mixedKey });

    expect(r.legacyKeys).toContain(lowerKey);
    expect(r.existing).toBe(signalEntry);
  });

  it("keeps freshest legacy lowercase Signal group aliases", () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const mixedKey = `agent:main:signal:group:${mixedGroupId}`;
    const lowerKey = mixedKey.toLowerCase();
    const staleCanonical = {
      sessionId: "stale-signal-canonical",
      updatedAt: 100,
    } as unknown as SessionEntry;
    const freshLegacy = {
      sessionId: "fresh-signal-legacy",
      updatedAt: 200,
    } as unknown as SessionEntry;
    const store: Record<string, SessionEntry> = {
      [mixedKey]: staleCanonical,
      [lowerKey]: freshLegacy,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: mixedKey });

    expect(r.legacyKeys).toContain(lowerKey);
    expect(r.existing).toBe(freshLegacy);
  });

  it("keeps freshest alias ordering for ordinary lowercase-canonical channels", () => {
    const canonicalKey = "agent:main:telegram:group:mixedcase";
    const legacyAliasKey = "agent:main:telegram:group:MixedCase";
    const staleCanonical = {
      sessionId: "stale-canonical",
      updatedAt: 100,
    } as unknown as SessionEntry;
    const freshAlias = {
      sessionId: "fresh-alias",
      updatedAt: 200,
    } as unknown as SessionEntry;
    const store: Record<string, SessionEntry> = {
      [canonicalKey]: staleCanonical,
      [legacyAliasKey]: freshAlias,
    };

    const r = resolveSessionStoreEntry({ store, sessionKey: legacyAliasKey });

    expect(r.legacyKeys).toContain(legacyAliasKey);
    expect(r.existing).toBe(freshAlias);
  });
});

describe("Matrix DM (direct) peer isolation under per-peer dmScope (#102313)", () => {
  const dmEntry = (mxid: string, updatedAt: number): SessionEntry =>
    ({
      updatedAt,
      deliveryContext: { channel: "matrix", to: "room:!dmroom:hs.example" },
      origin: { from: `matrix:${mxid}`, nativeChannelId: "!dmroom:hs.example" },
    }) as unknown as SessionEntry;
  const MXID_UPPER = "@Alice:hs.example";
  const MXID_LOWER = "@alice:hs.example";
  const dmKey = (
    peerId: string,
    dmScope: "per-channel-peer" | "per-account-channel-peer",
  ): string =>
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "matrix",
      accountId: "acct1",
      peerKind: "direct",
      peerId,
      dmScope,
    });

  it.each(["per-channel-peer", "per-account-channel-peer"] as const)(
    "builds distinct %s keys for case-distinct MXIDs",
    (dmScope) => {
      expect(dmKey(MXID_UPPER, dmScope)).not.toBe(dmKey(MXID_LOWER, dmScope));
      expect(dmKey(MXID_UPPER, dmScope)).toContain(MXID_UPPER);
      expect(dmKey(MXID_LOWER, dmScope)).toContain(MXID_LOWER);
    },
  );

  it.each(["per-channel-peer", "per-account-channel-peer"] as const)(
    "keeps %s keys distinct through store canonicalization",
    (dmScope) => {
      expect(normalizeSessionKeyPreservingOpaquePeerIds(dmKey(MXID_UPPER, dmScope))).not.toBe(
        normalizeSessionKeyPreservingOpaquePeerIds(dmKey(MXID_LOWER, dmScope)),
      );
    },
  );

  it("prefers the account-scoped shape when the Matrix account is named direct", () => {
    const key = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "matrix",
      accountId: "direct",
      peerKind: "direct",
      peerId: MXID_UPPER,
      dmScope: "per-account-channel-peer",
    });
    const legacyKey = key.toLowerCase();
    const store: Record<string, SessionEntry> = {
      [legacyKey]: dmEntry(MXID_LOWER, 50),
    };

    expect(key).toBe("agent:main:matrix:direct:direct:@Alice:hs.example");
    expect(normalizeSessionKeyPreservingOpaquePeerIds(key)).toBe(key);
    expect(requiresFoldedSessionKeyAliasProof(key)).toBe(true);
    expect(resolveSessionStoreEntry({ store, sessionKey: key })).toMatchObject({
      existing: undefined,
      legacyKeys: [],
    });
  });

  it.each([
    "agent:main:matrix:dm:@Alice:hs.example",
    "agent:main:matrix:acct1:dm:@Alice:hs.example",
  ])("preserves Matrix dm alias keys and rejects a case-distinct sibling (%s)", (key) => {
    const legacyKey = key.toLowerCase();
    const store: Record<string, SessionEntry> = {
      [legacyKey]: dmEntry(MXID_LOWER, 50),
    };

    expect(normalizeSessionKeyPreservingOpaquePeerIds(key)).toBe(key);
    expect(requiresFoldedSessionKeyAliasProof(key)).toBe(true);
    expect(resolveSessionStoreEntry({ store, sessionKey: key })).toMatchObject({
      existing: undefined,
      legacyKeys: [],
    });
  });

  it("does NOT return another peer's DM session for a case-distinct MXID", () => {
    const store: Record<string, SessionEntry> = {
      [dmKey(MXID_LOWER, "per-channel-peer")]: dmEntry(MXID_LOWER, 999),
    };
    const r = resolveSessionStoreEntry({
      store,
      sessionKey: dmKey(MXID_UPPER, "per-channel-peer"),
    });
    expect(r.existing).toBeUndefined();
    expect(r.legacyKeys).toEqual([]);
  });

  it("keeps two case-distinct peers on separate persisted DM sessions", () => {
    const store: Record<string, SessionEntry> = {
      [dmKey(MXID_UPPER, "per-channel-peer")]: dmEntry(MXID_UPPER, 100),
      [dmKey(MXID_LOWER, "per-channel-peer")]: dmEntry(MXID_LOWER, 999),
    };
    const upper = resolveSessionStoreEntry({
      store,
      sessionKey: dmKey(MXID_UPPER, "per-channel-peer"),
    });
    expect(upper.existing?.origin?.from).toBe(`matrix:${MXID_UPPER}`);
    expect(upper.legacyKeys).toEqual([]);
    const lower = resolveSessionStoreEntry({
      store,
      sessionKey: dmKey(MXID_LOWER, "per-channel-peer"),
    });
    expect(lower.existing?.origin?.from).toBe(`matrix:${MXID_LOWER}`);
  });

  const LEGACY_LOWERCASE_KEY = {
    "per-channel-peer": "agent:main:matrix:direct:@alice:hs.example",
    "per-account-channel-peer": "agent:main:matrix:acct1:direct:@alice:hs.example",
  } as const;

  it.each(["per-channel-peer", "per-account-channel-peer"] as const)(
    "requires folded-alias proof for %s DM keys",
    (dmScope) => {
      expect(requiresFoldedSessionKeyAliasProof(dmKey(MXID_UPPER, dmScope))).toBe(true);
    },
  );

  it.each(["per-channel-peer", "per-account-channel-peer"] as const)(
    "adopts the same peer's own lowercased legacy %s row on upgrade",
    (dmScope) => {
      const store: Record<string, SessionEntry> = {
        [LEGACY_LOWERCASE_KEY[dmScope]]: dmEntry(MXID_UPPER, 50),
      };
      const r = resolveSessionStoreEntry({ store, sessionKey: dmKey(MXID_UPPER, dmScope) });
      expect(r.normalizedKey).toBe(dmKey(MXID_UPPER, dmScope));
      expect(r.legacyKeys).toContain(LEGACY_LOWERCASE_KEY[dmScope]);
      expect(r.existing?.origin?.from).toBe(`matrix:${MXID_UPPER}`);
    },
  );

  it.each(["per-channel-peer", "per-account-channel-peer"] as const)(
    "rejects a case-distinct sibling's lowercased %s row instead of adopting or deleting it",
    (dmScope) => {
      const store: Record<string, SessionEntry> = {
        [LEGACY_LOWERCASE_KEY[dmScope]]: dmEntry(MXID_LOWER, 50),
      };
      const r = resolveSessionStoreEntry({ store, sessionKey: dmKey(MXID_UPPER, dmScope) });
      expect(r.existing).toBeUndefined();
      expect(r.legacyKeys).toEqual([]);
    },
  );

  it("keeps non-enrolled channel DMs folded to one session", () => {
    const telegramKey = (peerId: string): string =>
      buildAgentPeerSessionKey({
        agentId: "main",
        channel: "telegram",
        peerKind: "direct",
        peerId,
        dmScope: "per-channel-peer",
      });
    expect(telegramKey("MixedHandle")).toBe(telegramKey("mixedhandle"));
  });
});

describe("Matrix DM identityLinks continuity (#102313 review)", () => {
  const MXID_NATIVE = "@Alice:hs.example";
  const CANONICAL_LABEL = "alice";
  const identityLinks = { [CANONICAL_LABEL]: [`matrix:${MXID_NATIVE}`] };
  const linkedDmEntry = (updatedAt: number): SessionEntry =>
    ({
      updatedAt,
      deliveryContext: { channel: "matrix", to: "room:!dmroom:hs.example" },
      // The persisted row keeps the native MXID on origin even though the key
      // folds to the canonical label; proving the label against it would reject
      // the peer's own session on the second turn.
      origin: { from: `matrix:${MXID_NATIVE}`, nativeChannelId: "!dmroom:hs.example" },
    }) as unknown as SessionEntry;
  const linkedDmKey = (dmScope: "per-channel-peer" | "per-account-channel-peer"): string =>
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "matrix",
      accountId: "acct1",
      peerKind: "direct",
      peerId: MXID_NATIVE,
      dmScope,
      identityLinks,
    });

  it.each(["per-channel-peer", "per-account-channel-peer"] as const)(
    "folds a linked canonical label instead of preserving it as an MXID (%s)",
    (dmScope) => {
      const key = linkedDmKey(dmScope);
      expect(key).toContain(`:direct:${CANONICAL_LABEL}`);
      expect(key).not.toContain(MXID_NATIVE);
      // A folded canonical label carries no case-distinct sibling, so it needs
      // no case proof against the native origin MXID.
      expect(requiresFoldedSessionKeyAliasProof(key)).toBe(false);
    },
  );

  it.each(["per-channel-peer", "per-account-channel-peer"] as const)(
    "reuses the same peer's identity-linked DM session on the second turn (%s)",
    (dmScope) => {
      const key = linkedDmKey(dmScope);
      const store: Record<string, SessionEntry> = { [key]: linkedDmEntry(100) };
      const r = resolveSessionStoreEntry({ store, sessionKey: key });
      expect(r.normalizedKey).toBe(key);
      expect(r.existing?.origin?.from).toBe(`matrix:${MXID_NATIVE}`);
      expect(r.legacyKeys).toEqual([]);
    },
  );

  it("still folds a linked canonical label passed with mixed case", () => {
    expect(normalizeSessionPeerId({ channel: "matrix", peerKind: "direct", peerId: "Alice" })).toBe(
      "alice",
    );
  });

  const AT_CANONICAL = "@person:hs.example";
  const atLinks = { [AT_CANONICAL]: [`matrix:${MXID_NATIVE}`] };
  const atLinkedKey = (
    dmScope: "per-channel-peer" | "per-account-channel-peer" | "per-peer",
  ): string =>
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "matrix",
      accountId: "acct1",
      peerKind: "direct",
      peerId: MXID_NATIVE,
      dmScope,
      identityLinks: atLinks,
    });

  it("accepts an @-prefixed canonical label instead of rejecting the config", () => {
    const result = SessionSchema.safeParse({ identityLinks: atLinks });
    expect(result.success).toBe(true);
  });

  it.each(["per-channel-peer", "per-account-channel-peer", "per-peer"] as const)(
    "escapes an @-prefixed canonical label so it cannot masquerade as a native MXID (%s)",
    (dmScope) => {
      const key = atLinkedKey(dmScope);
      // The leading @ is percent-escaped, so the tail is opaque config text that
      // folds rather than a case-preserved native MXID.
      expect(key).toContain(":%40person:hs.example");
      expect(key).not.toContain(":@person");
      expect(requiresFoldedSessionKeyAliasProof(key)).toBe(false);
      // A distinct native peer whose MXID equals the label text keeps its own key.
      const nativeKey = buildAgentPeerSessionKey({
        agentId: "main",
        channel: "matrix",
        accountId: "acct1",
        peerKind: "direct",
        peerId: AT_CANONICAL,
        dmScope,
      });
      expect(key).not.toBe(nativeKey);
    },
  );

  it.each(["per-channel-peer", "per-account-channel-peer"] as const)(
    "reuses an @-prefixed canonical DM session on the second turn (%s)",
    (dmScope) => {
      const key = atLinkedKey(dmScope);
      const store: Record<string, SessionEntry> = { [key]: linkedDmEntry(100) };
      const r = resolveSessionStoreEntry({ store, sessionKey: key });
      expect(r.existing?.origin?.from).toBe(`matrix:${MXID_NATIVE}`);
      expect(r.legacyKeys).toEqual([]);
    },
  );
});

describe("Matrix DM identityLinks @-label vs plain label stay distinct (#102313 review)", () => {
  // Two operator-chosen canonical labels that differ only by a leading @; they
  // must never collapse onto one session (the escape is injective, not lossy).
  const AT_LABEL = "@person:hs.example";
  const PLAIN_LABEL = "person:hs.example";
  const ALICE = "@Alice:hs.example";
  const BOB = "@Bob:hs.example";
  const links = { [AT_LABEL]: [`matrix:${ALICE}`], [PLAIN_LABEL]: [`matrix:${BOB}`] };
  const dmEntry = (mxid: string, updatedAt: number): SessionEntry =>
    ({
      updatedAt,
      deliveryContext: { channel: "matrix", to: "room:!dmroom:hs.example" },
      origin: { from: `matrix:${mxid}`, nativeChannelId: "!dmroom:hs.example" },
    }) as unknown as SessionEntry;
  const keyFor = (
    peerId: string,
    dmScope: "per-channel-peer" | "per-account-channel-peer" | "per-peer",
    identityLinks?: Record<string, string[]>,
  ): string =>
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "matrix",
      accountId: "acct1",
      peerKind: "direct",
      peerId,
      dmScope,
      identityLinks,
    });

  it.each(["per-channel-peer", "per-account-channel-peer", "per-peer"] as const)(
    "fresh install: @person and person labels resolve to distinct sessions (%s)",
    (dmScope) => {
      const atKey = keyFor(ALICE, dmScope, links);
      const plainKey = keyFor(BOB, dmScope, links);
      expect(atKey).toContain(":%40person:hs.example");
      expect(plainKey).toContain(":person:hs.example");
      expect(plainKey).not.toContain(":%40person");
      expect(atKey).not.toBe(plainKey);
      // Neither label collides with a native peer whose MXID is literally @person.
      const nativeAtPerson = keyFor(AT_LABEL, dmScope);
      expect(atKey).not.toBe(nativeAtPerson);
      expect(plainKey).not.toBe(nativeAtPerson);
    },
  );

  it("upgrade: an existing person-label DM session is preserved and unclaimed by the @person label", () => {
    // The plain-label key shape is unchanged from prior releases, so the peer's
    // persisted session survives the upgrade.
    const plainKey = keyFor(BOB, "per-channel-peer", links);
    const store: Record<string, SessionEntry> = { [plainKey]: dmEntry(BOB, 100) };
    const plain = resolveSessionStoreEntry({ store, sessionKey: plainKey });
    expect(plain.existing?.origin?.from).toBe(`matrix:${BOB}`);
    // The @person label resolves elsewhere and adopts nothing from the plain row.
    const atKey = keyFor(ALICE, "per-channel-peer", links);
    const at = resolveSessionStoreEntry({ store, sessionKey: atKey });
    expect(at.existing).toBeUndefined();
    expect(at.legacyKeys).toEqual([]);
  });

  it("upgrade: a native @person peer keeps its own DM session, unclaimed by the @person label", () => {
    // The pre-branch @person key and a native @person peer's case-preserved key are
    // the same string. A row whose origin is literally @person is the native peer,
    // so the escaped %40person label neither reads nor deletes it.
    const nativeKey = keyFor(AT_LABEL, "per-channel-peer");
    const store: Record<string, SessionEntry> = { [nativeKey]: dmEntry(AT_LABEL, 100) };
    const atKey = keyFor(ALICE, "per-channel-peer", links);
    expect(atKey).not.toBe(nativeKey);
    const at = resolveSessionStoreEntry({ store, sessionKey: atKey });
    expect(at.existing).toBeUndefined();
    expect(at.legacyKeys).toEqual([]);
  });

  it("keeps an @person label and a literal %40person label on distinct sessions", () => {
    // Injective encoding: @person -> %40person, and a literal %40person -> %2540person.
    const atKey = keyFor(ALICE, "per-channel-peer", { [AT_LABEL]: [`matrix:${ALICE}`] });
    const literalKey = keyFor(BOB, "per-channel-peer", {
      "%40person:hs.example": [`matrix:${BOB}`],
    });
    expect(atKey).toContain(":%40person:hs.example");
    expect(literalKey).toContain(":%2540person:hs.example");
    expect(atKey).not.toBe(literalKey);
  });

  it("upgrade: adopts a pre-branch raw-@ identity-link DM session for the escaped key", () => {
    // Before this branch the @person label persisted at ...:direct:@person; a
    // returning linked peer keeps that session at the escaped %40person key, and
    // the raw key is returned for migration cleanup.
    const preBranchKey = "agent:main:matrix:direct:@person:hs.example";
    const store: Record<string, SessionEntry> = { [preBranchKey]: dmEntry(ALICE, 100) };
    const atKey = keyFor(ALICE, "per-channel-peer", links);
    const r = resolveSessionStoreEntry({ store, sessionKey: atKey });
    expect(r.existing?.origin?.from).toBe(`matrix:${ALICE}`);
    expect(r.legacyKeys).toContain(preBranchKey);
  });
});

describe("Matrix DM per-peer keys stay folded (#102313 review)", () => {
  const MXID_UPPER = "@Alice:hs.example";
  const MXID_LOWER = "@alice:hs.example";
  const perPeerKey = (peerId: string): string =>
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "matrix",
      peerKind: "direct",
      peerId,
      dmScope: "per-peer",
    });

  it("returns one folded route key for case-distinct MXIDs", () => {
    expect(perPeerKey(MXID_UPPER)).toBe(perPeerKey(MXID_LOWER));
    expect(perPeerKey(MXID_UPPER)).toBe("agent:main:direct:@alice:hs.example");
  });

  it("keeps the built route key identical to its persisted form", () => {
    const key = perPeerKey(MXID_UPPER);
    expect(normalizeSessionKeyPreservingOpaquePeerIds(key)).toBe(key);
  });
});
