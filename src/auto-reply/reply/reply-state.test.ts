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
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
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
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { CURRENT_MESSAGE_MARKER } from "./mentions.js";
import { resolveContextTokens } from "./model-selection-context.js";
import { incrementCompactionCount } from "./session-updates.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-compact-");

async function seedCompaction(storePath: string, sessionKey: string, entry: SessionEntry) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await upsertSessionEntryCore({ storePath, sessionKey }, entry);
  return { storePath, sessionKey, sessionEntry: entry, sessionStore: { [sessionKey]: entry } };
}

const loadStoredEntry = (storePath: string, sessionKey: string) =>
  expectDefined(
    loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" }),
    `expected persisted session entry for ${sessionKey}`,
  );

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

  it.each([
    ["entries", "A: one", ["one", "two"]],
    ["append", "A: one\nB: two", ["one", "two", "three"]],
    ["pending", "A: one\nB: two", ["one", "two"]],
  ] as const)("builds %s context without echoing the current entry", (source, history, bodies) => {
    const historyMap = createHistoryMapWithTwoEntries();
    const params = { ...context, historyMap };
    const result =
      source === "entries"
        ? buildHistoryContextFromEntries({ ...context, entries })
        : source === "append"
          ? buildHistoryContextFromMap({ ...params, entry: { sender: "C", body: "three" } })
          : buildPendingHistoryContextFromMap(params);
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(bodies);
    expect(result).toBe(
      `${HISTORY_CONTEXT_MARKER}\n${history}\n\n${CURRENT_MESSAGE_MARKER}\ncurrent`,
    );
  });

  it("trims history to configured limit", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    for (const entry of [...entries, { sender: "C", body: "three" }]) {
      recordPendingHistoryEntryIfEnabled({ historyMap, historyKey: "group", limit: 2, entry });
    }

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two", "three"]);
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

describe("shouldRunPreflightCompaction", () => {
  it("skips when entry is missing", () => {
    expect(shouldRunPreflightCompaction({ entry: undefined, threshold: 11_000 })).toBe(false);
  });

  it("honors the selected reserve in a 32K-token window", () => {
    const threshold = resolveCompactionThreshold({
      contextWindowTokens: 32_768,
      reserveTokensFloor: 20_000,
    });
    expect(threshold).toBe(12_768);
    for (const tokenCount of [12_767, 12_768, 12_769]) {
      expect(
        shouldRunPreflightCompaction({
          entry: {
            totalTokens: tokenCount,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
          },
          threshold,
        }),
      ).toBe(tokenCount >= 12_768);
    }
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
    const seeded = await seedCompaction(scopedStorePath, sessionKey, entry);
    await incrementCompactionCount({
      ...seeded,
      agentId: "main",
      storePath: durableStorePath,
    });

    expect(loadStoredEntry(scopedStorePath, sessionKey).compactionCount).toBe(1);
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
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "main";
    await incrementCompactionCount({
      ...(await seedCompaction(storePath, sessionKey, entry)),
      tokensAfter: 12_000,
    });

    const persisted = loadStoredEntry(storePath, sessionKey);
    expect(persisted).toMatchObject({
      compactionCount: 1,
      totalTokens: 12_000,
      totalTokensFresh: true,
    });
    expect(persisted.inputTokens).toBeUndefined();
    expect(persisted.outputTokens).toBeUndefined();
  });
});
