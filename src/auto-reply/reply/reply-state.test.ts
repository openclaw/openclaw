// Tests reply state persistence and recovery across process restarts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
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
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry | Record<string, unknown>;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await upsertSessionEntryCore(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    params.entry as Partial<SessionEntry>,
  );
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
  await seedSessionStore({ storePath, sessionKey, entry });
  return { storePath, sessionKey, sessionStore };
}

function requireStoredSession(stored: Record<string, SessionEntry>, sessionKey: string) {
  return expectDefined(stored[sessionKey], "stored[sessionKey] test invariant");
}

describe("history helpers", () => {
  function createHistoryMapWithTwoEntries() {
    const historyMap = new Map<string, { sender: string; body: string }[]>();
    historyMap.set("group", [
      { sender: "A", body: "one" },
      { sender: "B", body: "two" },
    ]);
    return historyMap;
  }

  it("returns current message when history is empty", () => {
    const result = buildHistoryContext({
      historyText: "  ",
      currentMessage: "hello",
    });
    expect(result).toBe("hello");
  });

  it("wraps history entries and excludes current by default", () => {
    const result = buildHistoryContextFromEntries({
      entries: [
        { sender: "A", body: "one" },
        { sender: "B", body: "two" },
      ],
      currentMessage: "current",
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
    });

    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).not.toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("trims history to configured limit", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: { sender: "A", body: "one" },
    });
    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: { sender: "B", body: "two" },
    });
    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: { sender: "C", body: "three" },
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two", "three"]);
  });

  it("builds context from map and appends entry", () => {
    const historyMap = createHistoryMapWithTwoEntries();

    const result = buildHistoryContextFromMap({
      historyMap,
      historyKey: "group",
      limit: 3,
      entry: { sender: "C", body: "three" },
      currentMessage: "current",
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
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
      historyKey: "group",
      limit: 3,
      currentMessage: "current",
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two"]);
    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("builds structured inbound history with media metadata", () => {
    const historyMap = new Map([
      [
        "group",
        [
          {
            sender: "Older",
            body: "zero",
            timestamp: 0,
          },
          {
            sender: "A",
            body: "one",
            timestamp: 1,
            messageId: "m1",
            media: [
              {
                path: "/tmp/image.png",
                contentType: "image/png",
                kind: "image" as const,
              },
            ],
          },
        ],
      ],
    ]);

    expect(buildInboundHistoryFromMap({ historyMap, historyKey: "group", limit: 1 })).toEqual([
      {
        sender: "A",
        body: "one",
        timestamp: 1,
        messageId: "m1",
        media: [{ path: "/tmp/image.png", contentType: "image/png", kind: "image" }],
      },
    ]);
    expect(
      buildInboundHistoryFromMap({ historyMap, historyKey: "group", limit: 0 }),
    ).toBeUndefined();
    expect(
      buildInboundHistoryFromEntries({ entries: historyMap.get("group") ?? [], limit: 1 }),
    ).toEqual([
      {
        sender: "A",
        body: "one",
        timestamp: 1,
        messageId: "m1",
        media: [{ path: "/tmp/image.png", contentType: "image/png", kind: "image" }],
      },
    ]);
  });

  it("records pending entries only when enabled", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 0,
      entry: { sender: "A", body: "one" },
    });
    expect(historyMap.get("group")).toEqual(undefined);

    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: null,
    });
    expect(historyMap.get("group")).toEqual(undefined);

    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: { sender: "B", body: "two" },
    });
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two"]);
  });

  it("clears history entries only when enabled", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();
    historyMap.set("group", [
      { sender: "A", body: "one" },
      { sender: "B", body: "two" },
    ]);

    clearHistoryEntriesIfEnabled({ historyMap, historyKey: "group", limit: 0 });
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two"]);

    clearHistoryEntriesIfEnabled({ historyMap, historyKey: "group", limit: 2 });
    expect(historyMap.get("group")).toStrictEqual([]);
  });
});

describe("shouldRunMemoryFlush", () => {
  it("skips when entry is missing", () => {
    expect(
      shouldRunMemoryFlush({
        entry: undefined,
        threshold: 11_000,
      }),
    ).toBe(false);
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

describe("shouldRunPreflightCompaction", () => {
  it("triggers when a projected token count crosses the threshold", () => {
    expect(
      shouldRunPreflightCompaction({
        entry: { totalTokens: 10, totalTokensFresh: false },
        tokenCount: 93_000,
        threshold: 93_000,
      }),
    ).toBe(true);
  });
});

describe("hasAlreadyFlushedForCurrentCompaction", () => {
  it("treats missing compactionCount as 0", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        memoryFlush: { kind: "succeeded", compactionCount: 0 },
      }),
    ).toBe(true);
  });
});

describe("resolveContextTokens", () => {
  it("uses provider-specific configured limits when the same model id exists on multiple providers", () => {
    const cfg = {
      models: {
        providers: {
          "provider-a": { models: [{ id: "shared-model", contextWindow: 200_000 }] },
          "provider-b": { models: [{ id: "shared-model", contextWindow: 512_000 }] },
        },
      },
    };
    expect(
      resolveContextTokens({
        cfg: cfg as never,
        provider: "provider-b",
        model: "shared-model",
      }),
    ).toBe(512_000);
    expect(
      resolveContextTokens({
        cfg: cfg as never,
        provider: "provider-a",
        model: "shared-model",
      }),
    ).toBe(200_000);
  });
});

describe("incrementCompactionCount", () => {
  it("persists incognito compaction metadata only in the scoped store", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-incognito-compact-"));
    tempDirs.push(tmp);
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
    await seedSessionStore({ storePath: scopedStorePath, sessionKey, entry });

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

    const stored = { [sessionKey]: await loadStoredEntry(storePath, sessionKey) };
    expect(requireStoredSession(stored, sessionKey).compactionCount).toBe(1);
    expect(requireStoredSession(stored, sessionKey).totalTokens).toBe(12_000);
    expect(requireStoredSession(stored, sessionKey).totalTokensFresh).toBe(true);
    // input/output cleared since we only have the total estimate
    expect(requireStoredSession(stored, sessionKey).inputTokens).toBeUndefined();
    expect(requireStoredSession(stored, sessionKey).outputTokens).toBeUndefined();
  });
});
