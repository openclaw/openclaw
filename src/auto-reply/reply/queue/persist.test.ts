import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./types.js";

// Mock resolveStateDir to use a temp directory
const MOCK_STATE_DIR = "/tmp/openclaw-test-persist";

vi.mock("../../../config/paths.js", () => ({
  resolveStateDir: () => MOCK_STATE_DIR,
}));

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { persistFollowupQueues, consumePersistedQueues } = await import("./persist.js");

function createMockFollowupRun(overrides?: Partial<FollowupRun>): FollowupRun {
  return {
    prompt: "test message",
    messageId: "msg-123",
    enqueuedAt: Date.now(),
    originatingChannel: "slack",
    originatingTo: "C123",
    originatingAccountId: "default",
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "sess-1",
      sessionKey: "agent:main:slack:channel:C123",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {} as never,
      provider: "anthropic",
      model: "claude-opus-4-6",
      timeoutMs: 600000,
      blockReplyBreak: "text_end",
    },
    ...overrides,
  };
}

describe("persistFollowupQueues", () => {
  beforeEach(async () => {
    await fs.mkdir(MOCK_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(MOCK_STATE_DIR, { recursive: true, force: true });
  });

  it("writes nothing when queues are empty", async () => {
    const queues = new Map<string, { items: FollowupRun[] }>();
    queues.set("key1", { items: [] });

    const result = await persistFollowupQueues(queues);
    expect(result).toBeNull();
  });

  it("persists non-empty queues to disk", async () => {
    const queues = new Map<string, { items: FollowupRun[] }>();
    const run = createMockFollowupRun({ prompt: "hello world" });
    queues.set("agent:main:slack:channel:C123", { items: [run] });

    const filePath = await persistFollowupQueues(queues);
    expect(filePath).toBeTruthy();
    expect(filePath).toContain("pending-messages.json");

    const content = await fs.readFile(filePath!, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].key).toBe("agent:main:slack:channel:C123");
    expect(parsed.entries[0].items).toHaveLength(1);
    expect(parsed.entries[0].items[0].prompt).toBe("hello world");
  });

  it("strips config and skillsSnapshot from persisted items", async () => {
    const queues = new Map<string, { items: FollowupRun[] }>();
    const run = createMockFollowupRun();
    run.run.config = { huge: "object" } as never;
    run.run.skillsSnapshot = { big: "snapshot" } as never;
    queues.set("key1", { items: [run] });

    const filePath = await persistFollowupQueues(queues);
    const content = await fs.readFile(filePath!, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.entries[0].items[0].run.config).toBeUndefined();
    expect(parsed.entries[0].items[0].run.skillsSnapshot).toBeUndefined();
  });

  it("persists multiple queues", async () => {
    const queues = new Map<string, { items: FollowupRun[] }>();
    queues.set("key1", { items: [createMockFollowupRun({ prompt: "msg1" })] });
    queues.set("key2", {
      items: [createMockFollowupRun({ prompt: "msg2" }), createMockFollowupRun({ prompt: "msg3" })],
    });
    queues.set("key3", { items: [] }); // empty, should be skipped

    const filePath = await persistFollowupQueues(queues);
    const content = await fs.readFile(filePath!, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.entries).toHaveLength(2);
  });
});

describe("consumePersistedQueues", () => {
  beforeEach(async () => {
    await fs.mkdir(MOCK_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(MOCK_STATE_DIR, { recursive: true, force: true });
  });

  it("returns null when no file exists", async () => {
    const result = await consumePersistedQueues();
    expect(result).toBeNull();
  });

  it("reads and deletes the file", async () => {
    const filePath = path.join(MOCK_STATE_DIR, "pending-messages.json");
    const data = {
      version: 1,
      persistedAt: Date.now(),
      entries: [
        {
          key: "key1",
          items: [createMockFollowupRun({ prompt: "persisted msg" })],
        },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(data), "utf-8");

    const result = await consumePersistedQueues();
    expect(result).toHaveLength(1);
    expect(result![0].items[0].prompt).toBe("persisted msg");

    // File should be deleted after consume
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("discards stale entries (older than 5 minutes)", async () => {
    const filePath = path.join(MOCK_STATE_DIR, "pending-messages.json");
    const data = {
      version: 1,
      persistedAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      entries: [
        {
          key: "key1",
          items: [createMockFollowupRun()],
        },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(data), "utf-8");

    const result = await consumePersistedQueues();
    expect(result).toBeNull();
  });

  it("discards corrupt files", async () => {
    const filePath = path.join(MOCK_STATE_DIR, "pending-messages.json");
    await fs.writeFile(filePath, "not json at all", "utf-8");

    const result = await consumePersistedQueues();
    expect(result).toBeNull();
  });

  it("discards files with wrong version", async () => {
    const filePath = path.join(MOCK_STATE_DIR, "pending-messages.json");
    const data = {
      version: 99,
      persistedAt: Date.now(),
      entries: [],
    };
    await fs.writeFile(filePath, JSON.stringify(data), "utf-8");

    const result = await consumePersistedQueues();
    expect(result).toBeNull();
  });
});

describe("round-trip: persist → consume", () => {
  beforeEach(async () => {
    await fs.mkdir(MOCK_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(MOCK_STATE_DIR, { recursive: true, force: true });
  });

  it("survives a full persist and consume cycle", async () => {
    const queues = new Map<string, { items: FollowupRun[] }>();
    queues.set("session:main", {
      items: [
        createMockFollowupRun({ prompt: "first message", messageId: "m1" }),
        createMockFollowupRun({ prompt: "second message", messageId: "m2" }),
      ],
    });

    await persistFollowupQueues(queues);
    const result = await consumePersistedQueues();

    expect(result).toHaveLength(1);
    expect(result![0].key).toBe("session:main");
    expect(result![0].items).toHaveLength(2);
    expect(result![0].items[0].prompt).toBe("first message");
    expect(result![0].items[1].prompt).toBe("second message");

    // Second consume should return null (file was deleted)
    const second = await consumePersistedQueues();
    expect(second).toBeNull();
  });
});
