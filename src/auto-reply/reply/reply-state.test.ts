import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  buildHistoryContext,
  buildHistoryContextFromEntries,
  buildHistoryContextFromMap,
  buildInboundHistoryFromEntries,
  buildInboundHistoryFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  HISTORY_CONTEXT_MARKER,
  recordPendingHistoryEntryIfEnabled,
} from "./history.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveCompactionThreshold,
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { CURRENT_MESSAGE_MARKER } from "./mentions.js";
import { resolveContextTokens } from "./model-selection-context.js";
import { incrementCompactionCount } from "./session-updates.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-compact-");

async function seedSessionStore(storePath: string, sessionKey: string, entry: SessionEntry) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await upsertSessionEntryCore({ storePath, sessionKey }, entry);
}

async function loadStoredEntry(storePath: string, sessionKey: string): Promise<SessionEntry> {
  const entry = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
  if (!entry) {
    throw new Error(`expected persisted session entry for ${sessionKey}`);
  }
  return entry;
}

async function createCompactionSessionFixture(entry: SessionEntry) {
  const tmp = sessionDirs.make();
  const storePath = path.join(tmp, "sessions.json");
  const sessionKey = "main";
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
  await seedSessionStore(storePath, sessionKey, entry);
  return { storePath, sessionKey, sessionStore };
}

describe("history helpers", () => {
  const entries = [
    { sender: "A", body: "one" },
    { sender: "B", body: "two" },
  ];
  const context = {
    historyKey: "group",
    limit: 3,
    currentMessage: "current",
    formatEntry: (entry: { sender: string; body: string }) => `${entry.sender}: ${entry.body}`,
  };
  function createHistoryMapWithTwoEntries() {
    return new Map([["group", [...entries]]]);
  }

  it("returns current message when history is empty", () => {
    expect(buildHistoryContext({ historyText: "  ", currentMessage: "hello" })).toBe("hello");
  });

  it("wraps history entries and excludes current by default", () => {
    const result = buildHistoryContextFromEntries({
      ...context,
      entries,
    });

    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).not.toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("trims history to configured limit", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    for (const entry of [...entries, { sender: "C", body: "three" }]) {
      recordPendingHistoryEntryIfEnabled({ historyMap, historyKey: "group", limit: 2, entry });
    }

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two", "three"]);
  });

  it("builds context from map and appends entry", () => {
    const historyMap = createHistoryMapWithTwoEntries();

    const result = buildHistoryContextFromMap({
      historyMap,
      ...context,
      entry: { sender: "C", body: "three" },
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two", "three"]);
    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).toContain("B: two");
    expect(result).not.toContain("C: three");
  });

  it("builds context from pending map without appending", () => {
    const historyMap = createHistoryMapWithTwoEntries();

    const result = buildPendingHistoryContextFromMap({
      historyMap,
      ...context,
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two"]);
    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("builds structured inbound history with media metadata", () => {
    const latest = {
      sender: "A",
      body: "one",
      timestamp: 1,
      messageId: "m1",
      media: [{ path: "/tmp/image.png", contentType: "image/png", kind: "image" as const }],
    };
    const historyMap = new Map([
      ["group", [{ sender: "Older", body: "zero", timestamp: 0 }, structuredClone(latest)]],
    ]);
    expect(buildInboundHistoryFromMap({ historyMap, historyKey: "group", limit: 1 })).toEqual([
      latest,
    ]);
    expect(
      buildInboundHistoryFromMap({ historyMap, historyKey: "group", limit: 0 }),
    ).toBeUndefined();
    expect(
      buildInboundHistoryFromEntries({ entries: historyMap.get("group") ?? [], limit: 1 }),
    ).toEqual([latest]);
  });

  it("records pending entries only when enabled", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();
    const record = (limit: number, entry: { sender: string; body: string } | null) =>
      recordPendingHistoryEntryIfEnabled({ historyMap, historyKey: "group", limit, entry });

    record(0, { sender: "A", body: "one" });
    expect(historyMap.get("group")).toEqual(undefined);

    record(2, null);
    expect(historyMap.get("group")).toEqual(undefined);

    record(2, { sender: "B", body: "two" });
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two"]);
  });

  it("clears history entries only when enabled", () => {
    const historyMap = createHistoryMapWithTwoEntries();

    clearHistoryEntriesIfEnabled({ historyMap, historyKey: "group", limit: 0 });
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two"]);

    clearHistoryEntriesIfEnabled({ historyMap, historyKey: "group", limit: 2 });
    expect(historyMap.get("group")).toStrictEqual([]);
  });
});

describe("shouldRunMemoryFlush", () => {
  it("skips when entry is missing", () => {
    expect(shouldRunMemoryFlush({ entry: undefined, threshold: 11_000 })).toBe(false);
  });

  it.each([[32_768, 20_000, 12_768]])(
    "honors the selected reserve in a %i-token window",
    (contextWindowTokens, reserveTokensFloor, expected) => {
      const threshold = resolveCompactionThreshold({ contextWindowTokens, reserveTokensFloor });
      expect(threshold).toBe(expected);
      for (const tokenCount of [expected - 1, expected, expected + 1]) {
        expect(
          shouldRunPreflightCompaction({
            entry: { totalTokens: tokenCount, totalTokensFresh: true, totalTokensVersion: 1 },
            threshold,
          }),
        ).toBe(expected > 0 && tokenCount >= expected);
      }
    },
  );

  it("skips when already flushed for current compaction count", () => {
    expect(
      shouldRunMemoryFlush({
        entry: {
          totalTokens: 96_000,
          totalTokensFresh: true,
          totalTokensVersion: 1,
          compactionCount: 2,
          memoryFlush: { kind: "succeeded", compactionCount: 2 },
        },
        threshold: 93_000,
      }),
    ).toBe(false);
  });
});

it("shouldRunPreflightCompaction triggers when a projected token count crosses the threshold", () => {
  expect(
    shouldRunPreflightCompaction({
      entry: { totalTokens: 10, totalTokensFresh: false },
      tokenCount: 93_000,
      threshold: 93_000,
    }),
  ).toBe(true);
});

it("hasAlreadyFlushedForCurrentCompaction treats missing compactionCount as 0", () => {
  expect(
    hasAlreadyFlushedForCurrentCompaction({
      memoryFlush: { kind: "succeeded", compactionCount: 0 },
    }),
  ).toBe(true);
});

it("resolveContextTokens uses provider-specific limits for the same model id", () => {
  const cfg = {
    models: {
      providers: {
        "provider-a": { models: [{ id: "shared-model", contextWindow: 200_000 }] },
        "provider-b": { models: [{ id: "shared-model", contextWindow: 512_000 }] },
      },
    },
  };
  const resolve = (provider: string) =>
    resolveContextTokens({ cfg: cfg as never, provider, model: "shared-model" });
  expect(resolve("provider-b")).toBe(512_000);
  expect(resolve("provider-a")).toBe(200_000);
});

describe("incrementCompactionCount", () => {
  it("persists incognito compaction metadata only in the scoped store", async () => {
    const tmp = sessionDirs.make();
    const durableStorePath = path.join(tmp, "sessions.json");
    const sessionKey = "agent:main:dashboard:incognito-compaction";
    const scopedStorePath = resolveSessionStorePathForScope({
      agentId: "main",
      sessionKey,
      storePath: durableStorePath,
    });
    const durableDatabasePath = resolveSqliteTargetFromSessionStorePath(durableStorePath, {
      agentId: "main",
    }).path;
    const entry = { sessionId: "incognito-session", updatedAt: 1 } as SessionEntry;
    const sessionStore = { [sessionKey]: entry };
    await seedSessionStore(scopedStorePath, sessionKey, entry);

    await incrementCompactionCount({
      agentId: "main",
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath: durableStorePath,
    });

    expect((await loadStoredEntry(scopedStorePath, sessionKey)).compactionCount).toBe(1);
    expect(durableDatabasePath).toBeDefined();
    await expect(
      fs.stat(expectDefined(durableDatabasePath, "durable database path")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("updates totalTokens when tokensAfter is provided", async () => {
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
      totalTokens: 180_000,
      inputTokens: 170_000,
      outputTokens: 10_000,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      tokensAfter: 12_000,
    });

    expect(await loadStoredEntry(storePath, sessionKey)).toMatchObject({
      compactionCount: 1,
      totalTokens: 12_000,
      totalTokensFresh: true,
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });
});
