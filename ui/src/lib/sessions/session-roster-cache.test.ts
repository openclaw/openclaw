/* @vitest-environment jsdom */
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { clearWarmBootState } from "../../app/bootstrap-warm-boot.ts";
import * as cacheDatabase from "./session-roster-cache-database.ts";
import {
  clearCachedBootState,
  flushSessionRosters,
  persistSessionRoster,
} from "./session-roster-cache.runtime.ts";
import {
  SESSION_ROSTER_DB_NAME,
  SESSION_ROSTER_MAX_AGE_MS,
  SESSION_ROSTER_MAX_BYTES,
  SESSION_ROSTER_STORE_NAME,
  sessionRosterCache,
  type SessionRosterRecord,
} from "./session-roster-cache.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

const expected = { agentId: "main", profileId: "profile-one", query: {} };
function record(
  scope = "gateway-one",
  rows: GatewaySessionRow[] = [{ key: "agent:main:one", kind: "direct" }],
): SessionRosterRecord {
  return {
    version: 1,
    scope,
    savedAt: Date.now(),
    profileId: "profile-one",
    agentId: "main",
    query: {},
    result: {
      ts: 1,
      path: "(multiple)",
      count: rows.length,
      defaults: { model: null, modelProvider: null, contextTokens: null },
      sessions: rows,
    },
    groups: ["Work"],
    groupSettings: [{ name: "Work", position: 0 }],
    sectionOrder: ["category:Work"],
  };
}

let lastPublication = 0;
function nextPublication(): number {
  lastPublication += 1;
  return lastPublication;
}

function persist(value: SessionRosterRecord): void {
  persistSessionRoster(value, nextPublication());
}

async function putRaw(value: unknown): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(SESSION_ROSTER_DB_NAME, 1);
    open.addEventListener("success", () => resolve(open.result));
    open.addEventListener("error", () =>
      reject(open.error ?? new Error("IndexedDB fixture open failed")),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SESSION_ROSTER_STORE_NAME, "readwrite");
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () =>
        reject(transaction.error ?? new Error("IndexedDB fixture transaction failed")),
      );
      transaction.objectStore(SESSION_ROSTER_STORE_NAME).put(value);
    });
  } finally {
    database.close();
  }
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(async () => {
  await clearCachedBootState();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("persistent session roster", () => {
  it.each(["persisted", "pending", "lazy", "in-flight"])(
    "retires only a legacy roster with %s work",
    async (stage) => {
      const scope = "ws://legacy-gateway.test";
      const peerScope = 'account:["ws://legacy-gateway.test","peer-account"]';
      const unrelatedScope = "ws://other-gateway.test";
      sessionRosterCache.write(record(scope));
      sessionRosterCache.write(record(peerScope));
      sessionRosterCache.write(record(unrelatedScope));
      await vi.dynamicImportSettled();
      await flushSessionRosters();
      const replacement = [{ key: "agent:main:replacement", kind: "direct" as const }];
      if (stage !== "persisted") {
        sessionRosterCache.write(record(scope, replacement));
        sessionRosterCache.write(record(peerScope, replacement));
        if (stage !== "lazy") {
          await vi.dynamicImportSettled();
        }
      }
      const entered = createDeferred();
      const release = createDeferred();
      let writing: Promise<void> | undefined;
      if (stage === "in-flight") {
        const open = cacheDatabase.openSessionRosterDatabase;
        vi.spyOn(cacheDatabase, "openSessionRosterDatabase").mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return open();
        });
        writing = flushSessionRosters();
        await entered.promise;
      }
      const readingPeer = sessionRosterCache.read(peerScope, expected);
      const clearing = clearWarmBootState(scope, {
        authMethod: "token",
        credential: "legacy-fingerprint",
      });
      release.resolve();
      await Promise.all([writing, clearing]);
      await vi.dynamicImportSettled();
      await flushSessionRosters();
      expect(await sessionRosterCache.read(scope, expected)).toBeNull();
      expect(await readingPeer).not.toBeNull();
      expect((await sessionRosterCache.read(peerScope, expected))?.result.sessions).toEqual(
        stage === "persisted" ? record().result.sessions : replacement,
      );
      expect((await sessionRosterCache.read(unrelatedScope, expected))?.result.sessions).toEqual(
        record().result.sessions,
      );
    },
  );

  it("keeps an unrelated owner's scheduled publication after exact retirement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    persist(record("retired"));
    persist(record("surviving"));
    await clearCachedBootState("retired");
    await vi.advanceTimersByTimeAsync(500);
    // Observe the normal scheduled write; an explicit flush would conceal a lost timer.
    await vi.waitFor(async () => {
      expect(await sessionRosterCache.read("surviving", expected)).not.toBeNull();
    });
    expect(await sessionRosterCache.read("retired", expected)).toBeNull();
  });

  it("round-trips durable sidebar fields while excluding live run state and avatars", async () => {
    const writes = vi.spyOn(IDBObjectStore.prototype, "put");
    const row: GatewaySessionRow = {
      key: "agent:main:one",
      kind: "direct",
      sessionId: "session-one",
      derivedTitle: "Warm conversation",
      lastMessagePreview: "Recent reply",
      updatedAt: 42,
      unread: true,
      archived: false,
      pinned: true,
      category: "Work",
      boardFace: "chat",
      thinkingLevel: "high",
      owner: { actor: { type: "human", id: "profile-one", avatarUrl: "/avatar" } },
      hasActiveRun: true,
      activeRunIds: ["run"],
      model: "primary",
      modelProvider: "example",
      activeModel: "fallback",
      activeModelProvider: "example",
      status: "running",
      runtimeMs: 30,
      runtimeSampledAt: 40,
      snapshotAt: 50,
      agentStatus: undefined,
      observerDigest: undefined,
      swarmPhase: "working",
      swarmPhaseRank: 2,
      swarmLog: "running",
      placement: undefined,
      placementMove: undefined,
      subagentRunState: "active",
      hasActiveSubagentRun: true,
      channelAvatarUrl: "/channel-avatar",
    };
    const source = record("gateway-one", [row]);
    source.query = { agentId: "main", source: "sidebar", rowMode: "compact" };
    persist(source);
    await flushSessionRosters();
    expect(writes).toHaveBeenCalledOnce();
    expect(JSON.stringify(writes.mock.calls[0]?.[0])).not.toMatch(/activeModel|snapshotAt/u);
    const saved = await sessionRosterCache.read(source.scope, expected);
    expect(saved?.query).not.toHaveProperty("source");
    expect(saved?.query).not.toHaveProperty("rowMode");
    expect(saved).toMatchObject({
      groups: ["Work"],
      groupSettings: source.groupSettings,
      sectionOrder: source.sectionOrder,
      result: {
        sessions: [
          {
            key: row.key,
            derivedTitle: row.derivedTitle,
            lastMessagePreview: row.lastMessagePreview,
            updatedAt: 42,
            unread: true,
            archived: false,
            pinned: true,
            category: "Work",
            boardFace: "chat",
            thinkingLevel: "high",
            model: "primary",
            modelProvider: "example",
            owner: { actor: { type: "human", id: "profile-one" } },
          },
        ],
      },
    });
    expect(JSON.stringify(saved)).not.toMatch(
      /hasActiveRun|activeRunIds|activeModel|runtimeMs|runtimeSampledAt|snapshotAt|swarmPhase|swarmLog|subagentRunState|hasActiveSubagentRun|avatarUrl|channelAvatarUrl|"status"/u,
    );
    expect(row.hasActiveRun).toBe(true);
    expect(row.snapshotAt).toBe(50);
    expect(await sessionRosterCache.read("gateway-two", expected)).toBeNull();
    await putRaw({ ...source, query: {} });
    const oldWriter = await sessionRosterCache.read(source.scope, {
      ...expected,
      query: source.query,
    });
    expect(oldWriter?.result.sessions[0]).toMatchObject({
      model: "primary",
      modelProvider: "example",
    });
    expect(oldWriter?.result.sessions[0]).not.toHaveProperty("activeModel");
    expect(oldWriter?.result.sessions[0]).not.toHaveProperty("activeModelProvider");
    expect(oldWriter?.result.sessions[0]).not.toHaveProperty("snapshotAt");
  });

  it("never persists Incognito rows and drops them from an older stored record", async () => {
    const durable: GatewaySessionRow = { key: "agent:main:one", kind: "direct" };
    const incognito: GatewaySessionRow = {
      key: "agent:main:dashboard:incognito-1",
      kind: "direct",
      incognito: true,
      derivedTitle: "Private conversation",
      lastMessagePreview: "Private reply",
    };
    persist(record("gateway-one", [durable, incognito]));
    await flushSessionRosters();
    const saved = await sessionRosterCache.read("gateway-one", expected);
    expect(saved?.result.sessions.map((row) => row.key)).toEqual([durable.key]);
    expect(JSON.stringify(saved)).not.toMatch(/incognito|Private/u);

    await putRaw(record("gateway-stale", [incognito, durable]));
    const restored = await sessionRosterCache.read("gateway-stale", expected);
    expect(restored?.result.sessions.map((row) => row.key)).toEqual([durable.key]);
  });

  it.each([
    ["profile", { ...expected, profileId: "profile-two" }],
    ["agent", { ...expected, agentId: "other" }],
    ["query", { ...expected, query: { search: "different" } }],
  ])("rejects a different %s without losing the valid record", async (_name, mismatch) => {
    persist(record());
    await flushSessionRosters();
    expect(await sessionRosterCache.read("gateway-one", mismatch)).toBeNull();
    expect(await sessionRosterCache.read("gateway-one", expected)).not.toBeNull();
  });

  it("rejects a roster whose saved query belongs to another agent", async () => {
    persist(record());
    await flushSessionRosters();
    await putRaw({ ...record(), query: { agentId: "other" } });
    expect(await sessionRosterCache.read("gateway-one", expected)).toBeNull();
  });

  it.each(["rows", "bytes"] as const)(
    "removes a prior record when the %s cap is exceeded",
    async (cap) => {
      persist(record());
      await flushSessionRosters();
      const oversized =
        cap === "rows"
          ? record(
              "gateway-one",
              Array.from({ length: 201 }, (_, index) => ({ key: String(index), kind: "direct" })),
            )
          : record("gateway-one", [
              {
                key: "one",
                kind: "direct",
                lastMessagePreview: "🦞".repeat(SESSION_ROSTER_MAX_BYTES / 4),
              },
            ]);
      persist(oversized);
      await flushSessionRosters();
      expect(await sessionRosterCache.read("gateway-one", expected)).toBeNull();
    },
  );

  it("evicts expired scopes and keeps only the newest six", async () => {
    const now = Date.now();
    for (let index = 0; index < 7; index += 1) {
      persist({ ...record(`gateway-${index}`), savedAt: now - index });
    }
    persist({ ...record("expired"), savedAt: now - SESSION_ROSTER_MAX_AGE_MS - 1 });
    await flushSessionRosters();
    expect(await sessionRosterCache.read("expired", expected)).toBeNull();
    expect(await sessionRosterCache.read("gateway-6", expected)).toBeNull();
    for (let index = 0; index < 6; index += 1) {
      expect(await sessionRosterCache.read(`gateway-${index}`, expected)).not.toBeNull();
    }
  });

  it("resets malformed stored shapes instead of publishing partial state", async () => {
    persist(record());
    persist(record("other"));
    await flushSessionRosters();
    await putRaw({ ...record(), result: { sessions: [{ key: 7 }] } });
    expect(await sessionRosterCache.read("gateway-one", expected)).toBeNull();
    expect(await sessionRosterCache.read("other", expected)).toBeNull();
    persist(record());
    await flushSessionRosters();
    expect(await sessionRosterCache.read("gateway-one", expected)).not.toBeNull();
  });

  it("recovers a cache written with a newer database version", async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(SESSION_ROSTER_DB_NAME, 2);
      open.addEventListener("upgradeneeded", () => open.result.createObjectStore("newer-shape"));
      open.addEventListener("success", () => resolve(open.result));
      open.addEventListener("error", () =>
        reject(open.error ?? new Error("IndexedDB fixture open failed")),
      );
    });
    database.close();
    persist(record());
    await flushSessionRosters();
    expect(await sessionRosterCache.read("gateway-one", expected)).toMatchObject({
      scope: "gateway-one",
      result: { sessions: [{ key: "agent:main:one" }] },
    });
  });

  it.each(["get", "getAll"] as const)(
    "recovers from an aborted roster %s request",
    async (method) => {
      persist(record());
      await flushSessionRosters();
      if (method === "get") {
        const aborted = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementationOnce(function (
          this: IDBObjectStore,
          key,
        ) {
          aborted.mockRestore();
          const request = this.get(key);
          this.transaction.abort();
          return request;
        });
        expect(await sessionRosterCache.read("gateway-one", expected)).toBeNull();
        aborted.mockRestore();
      } else {
        const aborted = vi
          .spyOn(IDBObjectStore.prototype, "getAll")
          .mockImplementationOnce(function (this: IDBObjectStore, query, count) {
            aborted.mockRestore();
            const request = this.getAll(query, count);
            this.transaction.abort();
            return request;
          });
        persist(record());
        await flushSessionRosters();
        aborted.mockRestore();
      }
      expect(await sessionRosterCache.read("gateway-one", expected)).toBeNull();
      persist(record());
      await flushSessionRosters();
      expect(await sessionRosterCache.read("gateway-one", expected)).toMatchObject({
        scope: "gateway-one",
        result: { sessions: [{ key: "agent:main:one" }] },
      });
    },
  );

  it("ignores a record that ages out after it was written", async () => {
    persist(record());
    await flushSessionRosters();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + SESSION_ROSTER_MAX_AGE_MS + 1);
    expect(await sessionRosterCache.read("gateway-one", expected)).toBeNull();
    vi.restoreAllMocks();
  });

  it("debounces writes and flushes them when the page is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    persist(record());
    expect(await sessionRosterCache.read("gateway-one", expected)).toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    await flushSessionRosters();
    expect(await sessionRosterCache.read("gateway-one", expected)).not.toBeNull();
    persist(record("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    await flushSessionRosters();
    expect(await sessionRosterCache.read("pagehide", expected)).not.toBeNull();
  });

  it.each([
    ["before", false],
    ["after", true],
  ])(
    "keeps the latest publication when an older runtime load settles %s the flush",
    async (_timing, flushBetween) => {
      const one: GatewaySessionRow = { key: "agent:main:one", kind: "direct" };
      const two: GatewaySessionRow = { key: "agent:main:two", kind: "direct" };
      const startupPublication = nextPublication();
      const completePublication = nextPublication();
      // Lazy runtime loads can settle in reverse publication order.
      persistSessionRoster(record("gateway-one", [one, two]), completePublication);
      if (flushBetween) {
        await flushSessionRosters();
      }
      persistSessionRoster(record("gateway-one", [one]), startupPublication);
      await flushSessionRosters();
      const saved = await sessionRosterCache.read("gateway-one", expected);
      expect(saved?.result.sessions.map((row) => row.key)).toEqual([one.key, two.key]);
    },
  );

  it("joins cache clearing before admitting a successor write", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const reset = cacheDatabase.resetSessionRosterDatabase;
    vi.spyOn(cacheDatabase, "resetSessionRosterDatabase").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      await reset();
    });
    const opened = vi.spyOn(cacheDatabase, "openSessionRosterDatabase");
    const clearing = clearCachedBootState();
    await entered.promise;
    persist(record("successor"));
    const writing = flushSessionRosters();
    try {
      await vi.dynamicImportSettled();
      expect(opened).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await clearing;
      await writing;
    }
    expect(await sessionRosterCache.read("successor", expected)).not.toBeNull();
  });

  it("clears roster writes awaiting the runtime import without retiring boot admission", async () => {
    localStorage.setItem(`${BOOT_RECORD_PREFIX}gateway-one`, "cached");
    persist(record());
    await flushSessionRosters();
    sessionRosterCache.write(record("pending"));
    await clearCachedBootState();
    await flushSessionRosters();
    expect(localStorage.getItem(`${BOOT_RECORD_PREFIX}gateway-one`)).toBe("cached");
    expect(await sessionRosterCache.read("gateway-one", expected)).toBeNull();
    expect(await sessionRosterCache.read("pending", expected)).toBeNull();
    localStorage.removeItem(`${BOOT_RECORD_PREFIX}gateway-one`);
  });
});
