import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type SessionEntryFixture = SessionEntry & {
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
  lastChannel?: string;
  lastTo?: string;
};

const storeState = vi.hoisted(() => {
  const state = {
    store: {} as Record<string, SessionEntryFixture>,
    stores: {} as Record<string, Record<string, SessionEntryFixture>>,
    readSessionEntriesFromStoreInWorker: vi.fn(
      async (scope: { storePath: string; sessionKeys: readonly string[] }) => {
        const store = state.stores[scope.storePath] ?? state.store;
        return {
          kind: "session-exact-entries" as const,
          entries: scope.sessionKeys.flatMap((sessionKey) =>
            Object.hasOwn(store, sessionKey)
              ? [{ sessionKey, entry: normalizeLegacySessionEntryDelivery(store[sessionKey]!) }]
              : [],
          ),
          source: { agentId: "main", path: scope.storePath },
        };
      },
    ),
    readSessionEntrySummariesInWorker: vi.fn(async (scope: { storePath?: string }) => {
      const store = state.stores[scope.storePath ?? ""] ?? state.store;
      return Object.entries(store).map(([sessionKey, entry]) => ({
        sessionKey,
        entry: normalizeLegacySessionEntryDelivery(entry),
      }));
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

vi.mock("./session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-entry-read-runtime.js")>()),
  readSessionEntriesFromStoreInWorker: storeState.readSessionEntriesFromStoreInWorker,
  readSessionEntrySummariesInWorker: storeState.readSessionEntrySummariesInWorker,
}));

vi.mock("./targets-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./targets-runtime.js")>()),
  resolveAllAgentSessionStoreTargetsAsync: async () => [
    { agentId: "main", storePath: "/tmp/sessions.json" },
    { agentId: "shadow", storePath: "/tmp/shadow-sessions.json" },
    { agentId: "worker", storePath: "/tmp/worker-sessions.json" },
  ],
}));

let extractDeliveryInfo: typeof import("./delivery-info.js").extractDeliveryInfo;
let extractDeliveryInfoBatch: typeof import("./delivery-info.js").extractDeliveryInfoBatch;

const legacyEntry = (fields: Partial<SessionEntryFixture>): SessionEntryFixture => ({
  sessionId: "session-1",
  updatedAt: Date.now(),
  ...fields,
});
const buildEntry = (deliveryContext: DeliveryContext, updatedAt = Date.now()) =>
  legacyEntry({ deliveryContext, updatedAt });

const matrixDelivery = {
  channel: "matrix",
  to: "room:!MixedCase:Example.Org",
  accountId: "matrix-account",
};
const telegramDelivery = { channel: "telegram", to: "telegram:user-123", accountId: "default" };
const foldedDelivery = { ...matrixDelivery, to: "room:!mixedcase:example.org" };
const MIXED_KEY = "agent:main:matrix:channel:!MixedCase:Example.Org";
const FOLDED_KEY = "agent:main:matrix:channel:!mixedcase:example.org";
const resultFor = (deliveryContext: DeliveryContext | undefined, threadId?: string) => ({
  deliveryContext,
  threadId,
});

async function expectDelivery(
  sessionKey: string,
  delivery: DeliveryContext | undefined,
  threadId?: string,
) {
  expect(await extractDeliveryInfo(sessionKey)).toEqual(resultFor(delivery, threadId));
}

beforeAll(async () => {
  ({ extractDeliveryInfo, extractDeliveryInfoBatch } = await import("./delivery-info.js"));
});

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
  storeState.store = {};
  storeState.stores = {};
  storeState.readSessionEntrySummariesInWorker.mockClear();
  storeState.readSessionEntriesFromStoreInWorker.mockClear();
});

describe("extractDeliveryInfo", () => {
  it("falls back to base sessions for :thread: keys", async () => {
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    const delivery = { channel: "slack", to: "slack:C0123ABC", accountId: "workspace-1" };
    storeState.store[baseKey] = buildEntry(delivery);
    await expectDelivery(threadKey, delivery, "1234567890.123456");
  });

  it("continues candidate session keys until it finds the freshest routable entry", async () => {
    storeState.store[MIXED_KEY] = legacyEntry({
      updatedAt: Date.now() - 1000,
      origin: { provider: "matrix" },
    });
    storeState.store[FOLDED_KEY] = legacyEntry({
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:Example.Org",
    });

    await expectDelivery(MIXED_KEY, { ...matrixDelivery, accountId: undefined });
  });

  it("finds legacy lowercase Signal group entries for mixed-case group keys", async () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const queriedKey = `agent:main:signal:group:${mixedGroupId}`;
    const legacyKey = queriedKey.toLowerCase();
    const delivery = {
      channel: "signal",
      to: `signal:group:${mixedGroupId}`,
      accountId: "default",
    };
    storeState.store[legacyKey] = buildEntry(delivery);
    await expectDelivery(queriedKey, delivery);
  });

  it("prefers the exact mixed-case Matrix entry over a fresher folded legacy alias", async () => {
    // Case-sensitive Matrix IDs must not collapse into a fresher legacy alias (#75670).
    storeState.store[MIXED_KEY] = buildEntry(matrixDelivery, Date.now() - 1_000);
    storeState.store[FOLDED_KEY] = buildEntry(foldedDelivery);

    await expectDelivery(MIXED_KEY, matrixDelivery);
  });

  it("finds Matrix thread entries with a legacy lowercased room and preserved event id", async () => {
    const queriedKey = `${MIXED_KEY}:thread:$RootEvent:Example.Org`;
    const legacyThreadKey = `${FOLDED_KEY}:thread:$RootEvent:Example.Org`;
    const delivery = { ...matrixDelivery, threadId: "$RootEvent:Example.Org" };
    storeState.store[legacyThreadKey] = buildEntry(delivery);

    await expectDelivery(queriedKey, delivery, "$RootEvent:Example.Org");
  });

  it.each<[string, string, string, DeliveryContext, string?]>([
    ["case-distinct sibling", MIXED_KEY, FOLDED_KEY, foldedDelivery],
    ["mismatched exact metadata", FOLDED_KEY, FOLDED_KEY, matrixDelivery],
    [
      "folded thread id",
      `${MIXED_KEY}:thread:$ThreadRootAbC`,
      `${FOLDED_KEY}:thread:$threadrootabc`,
      { ...matrixDelivery, threadId: "$threadrootabc" },
      "$ThreadRootAbC",
    ],
  ])(
    "does not return a Matrix route with %s",
    async (_name, query, storedKey, delivery, threadId) => {
      storeState.store[storedKey] = buildEntry(delivery);
      await expectDelivery(query, undefined, threadId);
    },
  );

  it("falls back to the base session when a thread entry only has partial route metadata", async () => {
    const baseKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const threadKey = `${baseKey}:thread:$thread-event`;
    storeState.store[threadKey] = legacyEntry({
      origin: { provider: "matrix", threadId: "$thread-event" },
    });
    storeState.store[baseKey] = legacyEntry({
      lastChannel: "matrix",
      lastTo: "room:!MixedCase:example.org",
    });

    await expectDelivery(
      threadKey,
      {
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: undefined,
      },
      "$thread-event",
    );
  });
});

describe("extractDeliveryInfoBatch", () => {
  it("shares alias discovery while preserving raw keys, thread fallback, and result order", async () => {
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
      await extractDeliveryInfoBatch([
        { sessionKey: canonicalKey },
        { sessionKey: queriedKey },
        { sessionKey: `${queriedKey}:topic:55` },
        {},
        { sessionKey: "agent:main:missing" },
        { sessionKey: queriedKey },
      ]),
    ).toEqual([
      resultFor(canonicalDelivery),
      resultFor(aliasDelivery),
      resultFor(aliasDelivery, "55"),
      resultFor(undefined),
      resultFor(undefined),
      resultFor(aliasDelivery),
    ]);
    expect(inventories).toBe(1);
  });

  it("keeps unreadable targets separate from healthy exact routes in the same store", async () => {
    const healthyKey = "agent:main:telegram:dm:healthy";
    const brokenKey = "agent:main:telegram:dm:broken";
    storeState.store[healthyKey] = buildEntry(telegramDelivery);
    Object.defineProperty(storeState.store, brokenKey, {
      enumerable: true,
      get() {
        throw new Error("unreadable session row");
      },
    });

    expect(
      await extractDeliveryInfoBatch(
        [brokenKey, healthyKey, "agent:main:missing", healthyKey].map((sessionKey) => ({
          sessionKey,
        })),
      ),
    ).toEqual([
      resultFor(undefined),
      resultFor(telegramDelivery),
      resultFor(undefined),
      resultFor(telegramDelivery),
    ]);
  });

  it("keeps global owners and ordered routable stores separate within one batch", async () => {
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
      await extractDeliveryInfoBatch(
        ["agent:worker:main", shadowKey, "agent:ops:main"].map((sessionKey) => ({ sessionKey })),
        {
          cfg: {
            session: { scope: "global" },
            agents: { ownership: "explicit", entries: { ops: {}, worker: {}, shadow: {} } },
          },
        },
      ),
    ).toEqual([resultFor(workerDelivery), resultFor(shadowDelivery), resultFor(opsDelivery)]);
    const admittedPaths = storeState.readSessionEntriesFromStoreInWorker.mock.calls.map(
      ([scope]) => scope.storePath,
    );
    expect(admittedPaths).not.toContain("/tmp/shadow-sessions.json");
  });
});
