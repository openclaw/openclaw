// Session delivery info tests cover persisted delivery metadata.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type SessionEntryFixture = SessionEntry & {
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

const storeState = vi.hoisted(() => {
  const state = {
    store: {} as Record<string, SessionEntryFixture>,
    stores: {} as Record<string, Record<string, SessionEntryFixture>>,
    loadExactSessionEntryCandidatesReadOnlyBatch: vi.fn(
      (
        scopes: Parameters<
          typeof import("./session-accessor.js").loadExactSessionEntryCandidatesReadOnlyBatch
        >[0],
      ) =>
        scopes.map((scope) => {
          const store = state.stores[scope.storePath ?? ""] ?? state.store;
          try {
            const value = scope.sessionKeys.flatMap((sessionKey) =>
              Object.hasOwn(store, sessionKey)
                ? [{ sessionKey, entry: normalizeLegacySessionEntryDelivery(store[sessionKey]!) }]
                : [],
            );
            scope.onReadSource?.({ agentId: "main", path: scope.storePath! });
            return { ok: true as const, value };
          } catch (error) {
            return { ok: false as const, error };
          }
        }),
    ),
    // Mirrors the accessor view contract: raw exact-key get, enumeration only via entries().
    openSessionEntryReadView: vi.fn((scope: { storePath?: string }) => {
      const store = state.stores[scope.storePath ?? ""] ?? state.store;
      return {
        get: (sessionKey: string) =>
          Object.hasOwn(store, sessionKey)
            ? normalizeLegacySessionEntryDelivery(store[sessionKey] as SessionEntry)
            : undefined,
        entries: () =>
          Object.entries(store).map(([sessionKey, entry]) => ({
            sessionKey,
            entry: normalizeLegacySessionEntryDelivery(entry),
          })),
      };
    }),
  };
  return state;
});

vi.mock("../io.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("./paths.js", () => ({
  resolveSessionStorePathCore: (_store?: string, opts?: { agentId?: string }) =>
    opts?.agentId === "worker" ? "/tmp/worker-sessions.json" : "/tmp/sessions.json",
}));

vi.mock("./session-accessor.js", () => ({
  loadExactSessionEntryCandidatesReadOnlyBatch:
    storeState.loadExactSessionEntryCandidatesReadOnlyBatch,
  openSessionEntryReadView: storeState.openSessionEntryReadView,
}));

vi.mock("./targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [
    { agentId: "main", storePath: "/tmp/sessions.json" },
    { agentId: "shadow", storePath: "/tmp/shadow-sessions.json" },
    { agentId: "worker", storePath: "/tmp/worker-sessions.json" },
  ],
}));

let extractDeliveryInfo: typeof import("./delivery-info.js").extractDeliveryInfo;
let extractDeliveryInfoBatch: typeof import("./delivery-info.js").extractDeliveryInfoBatch;

const buildEntry = (deliveryContext: DeliveryContext): SessionEntryFixture => ({
  sessionId: "session-1",
  updatedAt: Date.now(),
  deliveryContext,
});

function createMixedCaseMatrixDelivery(): DeliveryContext {
  return { channel: "matrix", to: "room:!MixedCase:Example.Org", accountId: "matrix-account" };
}

function createTelegramUserDelivery(): DeliveryContext {
  return { channel: "telegram", to: "telegram:user-123", accountId: "default" };
}

beforeAll(async () => {
  ({ extractDeliveryInfo, extractDeliveryInfoBatch } = await import("./delivery-info.js"));
});

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
  storeState.store = {};
  storeState.stores = {};
  storeState.openSessionEntryReadView.mockClear();
  storeState.loadExactSessionEntryCandidatesReadOnlyBatch.mockClear();
});

describe("extractDeliveryInfo", () => {
  it("falls back to base sessions for :thread: keys", () => {
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    storeState.store[baseKey] = buildEntry({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      },
      threadId: "1234567890.123456",
    });
  });

  it("continues candidate session keys until it finds the freshest routable entry", () => {
    const sessionKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    const canonicalKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[sessionKey] = {
      sessionId: "stale-session",
      updatedAt: Date.now() - 1000,
      origin: {
        provider: "matrix",
      },
    };
    storeState.store[canonicalKey] = {
      sessionId: "fresh-session",
      updatedAt: Date.now(),
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:Example.Org",
    };

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: undefined,
      },
      threadId: undefined,
    });
  });

  it("finds legacy lowercase Signal group entries for mixed-case group keys", () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const queriedKey = `agent:main:signal:group:${mixedGroupId}`;
    const legacyKey = queriedKey.toLowerCase();
    storeState.store[legacyKey] = buildEntry({
      channel: "signal",
      to: `signal:group:${mixedGroupId}`,
      accountId: "default",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "signal",
        to: `signal:group:${mixedGroupId}`,
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("prefers the exact mixed-case Matrix entry over a fresher folded legacy alias", () => {
    // Matrix room IDs are case-sensitive (openclaw#75670): the exact mixed-case
    // session is canonical and must win over a stale lowercased legacy alias even
    // when the alias is fresher. (Previously these collapsed to one lowercased key
    // and freshest won — that collapse was the bug.)
    const queriedKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    const legacyFoldedKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[queriedKey] = {
      sessionId: "exact-mixedcase-session",
      updatedAt: Date.now() - 1_000,
      deliveryContext: createMixedCaseMatrixDelivery(),
    };
    storeState.store[legacyFoldedKey] = {
      sessionId: "fresher-legacy-folded-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "matrix",
        to: "room:!mixedcase:example.org",
        accountId: "matrix-account",
      },
    };

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: createMixedCaseMatrixDelivery(),
      threadId: undefined,
    });
  });

  it("finds Matrix thread entries with a legacy lowercased room and preserved event id", () => {
    const queriedKey =
      "agent:main:matrix:channel:!MixedCase:Example.Org:thread:$RootEvent:Example.Org";
    const legacyThreadKey =
      "agent:main:matrix:channel:!mixedcase:example.org:thread:$RootEvent:Example.Org";
    storeState.store[legacyThreadKey] = {
      sessionId: "legacy-thread-session",
      updatedAt: Date.now(),
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
        threadId: "$RootEvent:Example.Org",
      },
    };

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:Example.Org",
        accountId: "matrix-account",
        threadId: "$RootEvent:Example.Org",
      },
      threadId: "$RootEvent:Example.Org",
    });
  });

  it("does not return a case-distinct lowercase Matrix sibling when the mixed-case key has no exact entry", () => {
    const queriedKey = "agent:main:matrix:channel:!MixedCase:Example.Org";
    const lowercaseSiblingKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[lowercaseSiblingKey] = buildEntry({
      channel: "matrix",
      to: "room:!mixedcase:example.org",
      accountId: "matrix-account",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: undefined,
      threadId: undefined,
    });
  });

  it("does not return an exact lowercase Matrix key with mixed-case delivery metadata", () => {
    const queriedKey = "agent:main:matrix:channel:!mixedcase:example.org";
    storeState.store[queriedKey] = buildEntry(createMixedCaseMatrixDelivery());

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: undefined,
      threadId: undefined,
    });
  });

  it("does not return a folded Matrix thread artifact when the stored thread id differs by case", () => {
    const queriedKey = "agent:main:matrix:channel:!MixedCase:Example.Org:thread:$ThreadRootAbC";
    const foldedThreadKey =
      "agent:main:matrix:channel:!mixedcase:example.org:thread:$threadrootabc";
    storeState.store[foldedThreadKey] = buildEntry({
      channel: "matrix",
      to: "room:!MixedCase:Example.Org",
      accountId: "matrix-account",
      threadId: "$threadrootabc",
    });

    const result = extractDeliveryInfo(queriedKey);

    expect(result).toEqual({
      deliveryContext: undefined,
      threadId: "$ThreadRootAbC",
    });
  });

  it("falls back to the base session when a thread entry only has partial route metadata", () => {
    const baseKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const threadKey = `${baseKey}:thread:$thread-event`;
    storeState.store[threadKey] = {
      sessionId: "thread-session",
      updatedAt: Date.now(),
      origin: {
        provider: "matrix",
        threadId: "$thread-event",
      },
    };
    storeState.store[baseKey] = {
      sessionId: "base-session",
      updatedAt: Date.now(),
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:example.org",
    };

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: undefined,
      },
      threadId: "$thread-event",
    });
  });
});

describe("extractDeliveryInfoBatch", () => {
  it("shares alias discovery while preserving raw keys, thread fallback, and result order", () => {
    const canonicalKey = "agent:main:telegram:group:mixedcase";
    const queriedKey = "agent:main:telegram:group:MiXeDCase";
    const aliasKey = "agent:main:telegram:group:MixedCase";
    const canonicalDelivery = { channel: "telegram", to: "telegram:old-route" };
    const aliasDelivery = { channel: "telegram", to: "telegram:fresh-route" };
    let inventories = 0;
    storeState.store = new Proxy(
      {
        [canonicalKey]: { ...buildEntry(canonicalDelivery), updatedAt: 1 },
        [aliasKey]: { ...buildEntry(aliasDelivery), updatedAt: 2 },
      },
      {
        ownKeys(target) {
          if (++inventories > 1) {
            throw new Error("alias inventory was repeated inside one batch");
          }
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(
      extractDeliveryInfoBatch([
        canonicalKey,
        queriedKey,
        `${queriedKey}:topic:55`,
        undefined,
        "agent:main:missing",
        queriedKey,
      ]),
    ).toEqual([
      { deliveryContext: canonicalDelivery, threadId: undefined },
      { deliveryContext: aliasDelivery, threadId: undefined },
      { deliveryContext: aliasDelivery, threadId: "55" },
      { deliveryContext: undefined, threadId: undefined },
      { deliveryContext: undefined, threadId: undefined },
      { deliveryContext: aliasDelivery, threadId: undefined },
    ]);
    expect(inventories).toBe(1);
  });

  it("keeps unreadable targets separate from healthy exact routes in the same store", () => {
    const healthyKey = "agent:main:telegram:dm:healthy";
    const brokenKey = "agent:main:telegram:dm:broken";
    storeState.store[healthyKey] = buildEntry(createTelegramUserDelivery());
    Object.defineProperty(storeState.store, brokenKey, {
      enumerable: true,
      get() {
        throw new Error("unreadable session row");
      },
    });

    expect(
      extractDeliveryInfoBatch([brokenKey, healthyKey, "agent:main:missing", healthyKey]),
    ).toEqual([
      { deliveryContext: undefined, threadId: undefined },
      { deliveryContext: createTelegramUserDelivery(), threadId: undefined },
      { deliveryContext: undefined, threadId: undefined },
      { deliveryContext: createTelegramUserDelivery(), threadId: undefined },
    ]);
  });

  it("keeps global owners and ordered routable stores separate within one batch", () => {
    const shadowKey = "agent:shadow:telegram:dm:shadow";
    const opsDelivery = { channel: "telegram", to: "telegram:ops" };
    const workerDelivery = { channel: "telegram", to: "telegram:worker" };
    const shadowDelivery = { channel: "telegram", to: "telegram:shadow" };
    storeState.stores["/tmp/sessions.json"] = {
      global: buildEntry(opsDelivery),
      [shadowKey]: buildEntry(shadowDelivery),
    };
    storeState.stores["/tmp/worker-sessions.json"] = { global: buildEntry(workerDelivery) };
    storeState.stores["/tmp/shadow-sessions.json"] = {};
    Object.defineProperty(storeState.stores["/tmp/shadow-sessions.json"], shadowKey, {
      enumerable: true,
      get() {
        throw new Error("later store is unreadable");
      },
    });

    expect(
      extractDeliveryInfoBatch(["agent:worker:main", shadowKey, "agent:ops:main"], {
        cfg: {
          session: { scope: "global" },
          agents: { ownership: "explicit", entries: { ops: {}, worker: {}, shadow: {} } },
        },
      }),
    ).toEqual([
      { deliveryContext: workerDelivery, threadId: undefined },
      { deliveryContext: shadowDelivery, threadId: undefined },
      { deliveryContext: opsDelivery, threadId: undefined },
    ]);
    const admittedPaths =
      storeState.loadExactSessionEntryCandidatesReadOnlyBatch.mock.calls.flatMap(([scopes]) =>
        scopes.map((scope) => scope.storePath),
      );
    expect(admittedPaths).not.toContain("/tmp/shadow-sessions.json");
  });
});
