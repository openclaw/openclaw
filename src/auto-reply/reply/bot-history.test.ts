import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: vi.fn(),
}));

let fixtureRoot: string;
let storeCounter = 0;

function makeStorePath(): string {
  storeCounter += 1;
  return path.join(fixtureRoot, `pending-${storeCounter}.json`);
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bot-history-test-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("bot-history store", () => {
  afterEach(() => vi.restoreAllMocks());

  it("readBotHistoryEntries returns [] when store does not exist", async () => {
    const { _resetBotHistoryCache, readBotHistoryEntries } = await import("./bot-history.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    const result = await readBotHistoryEntries({ channel: "telegram", to: "user1" }, { storePath });
    expect(result).toEqual([]);
  });

  it("appendBotHistoryEntry writes and readBotHistoryEntries retrieves", async () => {
    const { _resetBotHistoryCache, appendBotHistoryEntry, readBotHistoryEntries } =
      await import("./bot-history.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    await appendBotHistoryEntry(
      {
        channel: "telegram",
        to: "user1",
        text: "hello",
        timestamp: Date.now(),
      },
      { storePath },
    );
    const entries = await readBotHistoryEntries(
      { channel: "telegram", to: "user1" },
      { storePath },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("hello");
    expect(entries[0]?.id).toBeDefined();
  });

  it("readBotHistoryEntries filters by channel + to", async () => {
    const { _resetBotHistoryCache, appendBotHistoryEntry, readBotHistoryEntries } =
      await import("./bot-history.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    const now = Date.now();
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "msg-a", timestamp: now },
      { storePath },
    );
    await appendBotHistoryEntry(
      { channel: "discord", to: "user1", text: "msg-b", timestamp: now },
      { storePath },
    );
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user2", text: "msg-c", timestamp: now },
      { storePath },
    );

    const results = await readBotHistoryEntries(
      { channel: "telegram", to: "user1" },
      { storePath },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe("msg-a");
  });

  it("readBotHistoryEntries uses strict equality for accountId and threadId", async () => {
    const { _resetBotHistoryCache, appendBotHistoryEntry, readBotHistoryEntries } =
      await import("./bot-history.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    const now = Date.now();

    // Entry with accountId + threadId
    await appendBotHistoryEntry(
      {
        channel: "telegram",
        to: "user1",
        accountId: "acct-A",
        threadId: "thread-42",
        text: "targeted",
        timestamp: now,
      },
      { storePath },
    );
    // Entry with different accountId
    await appendBotHistoryEntry(
      {
        channel: "telegram",
        to: "user1",
        accountId: "acct-C",
        threadId: "thread-42",
        text: "other-acct",
        timestamp: now,
      },
      { storePath },
    );

    // Exact match
    const exact = await readBotHistoryEntries(
      { channel: "telegram", to: "user1", accountId: "acct-A", threadId: "thread-42" },
      { storePath },
    );
    expect(exact).toHaveLength(1);
    expect(exact[0]?.text).toBe("targeted");

    // Different accountId — should not match
    const wrongAcct = await readBotHistoryEntries(
      { channel: "telegram", to: "user1", accountId: "acct-C", threadId: "thread-42" },
      { storePath },
    );
    expect(wrongAcct).toHaveLength(1);
    expect(wrongAcct[0]?.text).toBe("other-acct");

    // Undefined accountId query — should not match entries that have accountId set
    const noAcct = await readBotHistoryEntries({ channel: "telegram", to: "user1" }, { storePath });
    expect(noAcct).toHaveLength(0);
  });

  it("removeBotHistoryEntries removes specific entries by id", async () => {
    const {
      _resetBotHistoryCache,
      appendBotHistoryEntry,
      readBotHistoryEntries,
      removeBotHistoryEntries,
    } = await import("./bot-history.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    const now = Date.now();
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "keep", timestamp: now },
      { storePath },
    );
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "remove-me", timestamp: now + 1 },
      { storePath },
    );

    const before = await readBotHistoryEntries({ channel: "telegram", to: "user1" }, { storePath });
    expect(before).toHaveLength(2);

    const removeId = before.find((e) => e.text === "remove-me")?.id;
    expect(removeId).toBeDefined();
    await removeBotHistoryEntries([removeId!], { storePath });

    const after = await readBotHistoryEntries({ channel: "telegram", to: "user1" }, { storePath });
    expect(after).toHaveLength(1);
    expect(after[0]?.text).toBe("keep");
  });

  it("compactBotHistoryStore removes entries older than TTL", async () => {
    const { _resetBotHistoryCache, appendBotHistoryEntry, compactBotHistoryStore } =
      await import("./bot-history.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    const OLD_MS = 25 * 60 * 60 * 1000; // 25 hours ago — older than 24-hour TTL
    const now = Date.now();

    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "old", timestamp: now - OLD_MS },
      { storePath },
    );
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "fresh", timestamp: now },
      { storePath },
    );

    const removed = await compactBotHistoryStore({ storePath });
    expect(removed).toBe(1);

    // Verify fresh entry still present via raw file read
    const raw = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
      entries: Array<{ text: string }>;
    };
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0]?.text).toBe("fresh");
  });

  it("appendBotHistoryEntry enforces max 500 entries", async () => {
    const { _resetBotHistoryCache, appendBotHistoryEntry, readBotHistoryEntries } =
      await import("./bot-history.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    const now = Date.now();

    // Write 500 entries
    for (let i = 0; i < 500; i++) {
      await appendBotHistoryEntry(
        { channel: "telegram", to: "user1", text: `msg-${i}`, timestamp: now + i },
        { storePath },
      );
    }

    // One more — should push out the oldest
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "msg-500", timestamp: now + 500 },
      { storePath },
    );

    const entries = await readBotHistoryEntries(
      { channel: "telegram", to: "user1" },
      { storePath },
    );
    expect(entries.length).toBeLessThanOrEqual(500);
    expect(entries.some((e) => e.text === "msg-0")).toBe(false);
    expect(entries.some((e) => e.text === "msg-500")).toBe(true);
  }, 30_000);

  it("store persists to disk and survives cache reset", async () => {
    const { _resetBotHistoryCache, appendBotHistoryEntry, readBotHistoryEntries } =
      await import("./bot-history.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "persisted", timestamp: Date.now() },
      { storePath },
    );

    // Reset the in-memory cache to force a disk read
    _resetBotHistoryCache();

    const entries = await readBotHistoryEntries(
      { channel: "telegram", to: "user1" },
      { storePath },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("persisted");
  });
});

describe("flushBotHistoryToTranscript", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("flushes matching entries to session transcript and removes them", async () => {
    const { _resetBotHistoryCache, appendBotHistoryEntry, flushBotHistoryToTranscript } =
      await import("./bot-history.js");
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    const now = Date.now();

    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "first", timestamp: now },
      { storePath },
    );
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "second", timestamp: now + 1 },
      { storePath },
    );

    vi.mocked(appendAssistantMessageToSessionTranscript).mockResolvedValue({
      ok: true,
      sessionFile: "/tmp/test.jsonl",
    });

    const count = await flushBotHistoryToTranscript({
      channel: "telegram",
      to: "user1",
      sessionKey: "sk-test",
      agentId: "agent-1",
      storePath,
    });

    expect(count).toBe(2);
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(2);

    // Entries should be removed after successful flush
    const { readBotHistoryEntries } = await import("./bot-history.js");
    const remaining = await readBotHistoryEntries(
      { channel: "telegram", to: "user1" },
      { storePath },
    );
    expect(remaining).toHaveLength(0);
  });

  it("returns 0 when no matching entries exist", async () => {
    const { _resetBotHistoryCache, flushBotHistoryToTranscript } = await import("./bot-history.js");
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();

    const count = await flushBotHistoryToTranscript({
      channel: "telegram",
      to: "no-such-user",
      sessionKey: "sk-test",
      agentId: "agent-1",
      storePath,
    });

    expect(count).toBe(0);
    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("keeps entries that fail to flush", async () => {
    const {
      _resetBotHistoryCache,
      appendBotHistoryEntry,
      flushBotHistoryToTranscript,
      readBotHistoryEntries,
    } = await import("./bot-history.js");
    const { appendAssistantMessageToSessionTranscript } =
      await import("../../config/sessions/transcript.js");
    _resetBotHistoryCache();
    const storePath = makeStorePath();
    const now = Date.now();

    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "ok-entry", timestamp: now },
      { storePath },
    );
    await appendBotHistoryEntry(
      { channel: "telegram", to: "user1", text: "fail-entry", timestamp: now + 1 },
      { storePath },
    );

    // First call succeeds, second fails
    vi.mocked(appendAssistantMessageToSessionTranscript)
      .mockResolvedValueOnce({ ok: true, sessionFile: "/tmp/test.jsonl" })
      .mockResolvedValueOnce({ ok: false, reason: "unknown sessionKey" });

    const count = await flushBotHistoryToTranscript({
      channel: "telegram",
      to: "user1",
      sessionKey: "sk-test",
      agentId: "agent-1",
      storePath,
    });

    expect(count).toBe(1);

    // Failed entry should remain in the store
    const remaining = await readBotHistoryEntries(
      { channel: "telegram", to: "user1" },
      { storePath },
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.text).toBe("fail-entry");
  });
});
