import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { OpenClawConfig } from "../types.openclaw.js";
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
async function expectBatch(
  rows: Array<[string | undefined, DeliveryContext | undefined, string?]>,
  cfg?: OpenClawConfig,
) {
  const requests = rows.map(([sessionKey]) => (sessionKey === undefined ? {} : { sessionKey }));
  expect(await extractDeliveryInfoBatch(requests, { cfg })).toEqual(
    rows.map(([, delivery, threadId]) => resultFor(delivery, threadId)),
  );
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

const signalGroup = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
const signalKey = `agent:main:signal:group:${signalGroup}`;
const signalDelivery = {
  channel: "signal",
  to: `signal:group:${signalGroup}`,
  accountId: "default",
};
const rootEvent = "$RootEvent:Example.Org";
const threadDelivery = { ...matrixDelivery, threadId: rootEvent };
const partialBase = "agent:main:matrix:channel:!MixedCase:example.org";
type RouteCase = [string, string, Record<string, SessionEntryFixture>, DeliveryContext?, string?];
it.each<RouteCase>([
  [
    "continues to the freshest routable candidate",
    MIXED_KEY,
    {
      [MIXED_KEY]: legacyEntry({ updatedAt: 1, origin: { provider: "matrix" } }),
      [FOLDED_KEY]: legacyEntry({ lastChannel: "matrix", lastTo: matrixDelivery.to }),
    },
    { ...matrixDelivery, accountId: undefined },
  ],
  [
    "finds a legacy Signal group",
    signalKey,
    { [signalKey.toLowerCase()]: buildEntry(signalDelivery) },
    signalDelivery,
  ],
  [
    "prefers exact Matrix case over a fresher alias (#75670)",
    MIXED_KEY,
    { [MIXED_KEY]: buildEntry(matrixDelivery, 1), [FOLDED_KEY]: buildEntry(foldedDelivery, 2) },
    matrixDelivery,
  ],
  [
    "preserves Matrix event case in a legacy room alias",
    `${MIXED_KEY}:thread:${rootEvent}`,
    { [`${FOLDED_KEY}:thread:${rootEvent}`]: buildEntry(threadDelivery) },
    threadDelivery,
    rootEvent,
  ],
  [
    "rejects a case-distinct Matrix sibling",
    MIXED_KEY,
    { [FOLDED_KEY]: buildEntry(foldedDelivery) },
  ],
  ["rejects mismatched Matrix metadata", FOLDED_KEY, { [FOLDED_KEY]: buildEntry(matrixDelivery) }],
  [
    "rejects a folded Matrix event id",
    `${MIXED_KEY}:thread:$ThreadRootAbC`,
    {
      [`${FOLDED_KEY}:thread:$threadrootabc`]: buildEntry({
        ...matrixDelivery,
        threadId: "$threadrootabc",
      }),
    },
    undefined,
    "$ThreadRootAbC",
  ],
  [
    "falls back from partial thread metadata to its base route",
    `${partialBase}:thread:$thread-event`,
    {
      [`${partialBase}:thread:$thread-event`]: legacyEntry({
        origin: { provider: "matrix", threadId: "$thread-event" },
      }),
      [partialBase]: legacyEntry({ lastChannel: "matrix", lastTo: "room:!MixedCase:example.org" }),
    },
    { channel: "matrix", to: "room:!MixedCase:example.org", accountId: undefined },
    "$thread-event",
  ],
])("extractDeliveryInfo %s", async (_name, query, entries, delivery, threadId) => {
  storeState.store = entries;
  await expectDelivery(query, delivery, threadId);
});

describe("extractDeliveryInfoBatch", () => {
  it("shares Signal alias discovery while preserving thread fallback and result order", async () => {
    const canonicalKey = "agent:main:signal:group:mixedcase";
    const queriedKey = "AGENT:main:signal:group:MiXeDCase";
    const aliasKey = "agent:main:signal:group:MixedCase";
    const canonicalDelivery = { channel: "signal", to: "signal:group:mixedcase" };
    const aliasDelivery = { channel: "signal", to: "signal:group:MixedCase" };
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

    await expectBatch([
      [canonicalKey, canonicalDelivery],
      [queriedKey, aliasDelivery],
      [`${queriedKey}:thread:55`, aliasDelivery, "55"],
      [undefined, undefined],
      ["agent:main:missing", undefined],
      [queriedKey, aliasDelivery],
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

    await expectBatch([
      [brokenKey, undefined],
      [healthyKey, telegramDelivery],
      ["agent:main:missing", undefined],
      [healthyKey, telegramDelivery],
    ]);
    expect(storeState.readSessionEntriesFromStoreInWorker).toHaveBeenCalledTimes(4);
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

    await expectBatch(
      [
        ["agent:worker:main", workerDelivery],
        [shadowKey, shadowDelivery],
        ["agent:ops:main", opsDelivery],
      ],
      {
        session: { scope: "global" },
        agents: { ownership: "explicit", entries: { ops: {}, worker: {}, shadow: {} } },
      },
    );
    const admittedPaths = storeState.readSessionEntriesFromStoreInWorker.mock.calls.map(
      ([scope]) => scope.storePath,
    );
    expect(admittedPaths).not.toContain("/tmp/shadow-sessions.json");
  });
});
