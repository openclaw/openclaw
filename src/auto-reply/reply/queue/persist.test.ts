import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { persistFollowupQueues, consumePersistedFollowups } from "./persist.js";
import { FOLLOWUP_QUEUES, type FollowupQueueState } from "./state.js";
import type { FollowupRun } from "./types.js";

function makeFollowupRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "Hello, how are you?",
    messageId: "msg-123",
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    originatingTo: "12345",
    originatingAccountId: "acc-1",
    originatingThreadId: "thread-1",
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "sess-1",
      sessionKey: "test-session",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      config: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-4",
      timeoutMs: 60000,
      blockReplyBreak: "text_end",
      senderId: "user-1",
      senderName: "Test User",
    },
    ...overrides,
  };
}

function makeQueueState(items: FollowupRun[]): FollowupQueueState {
  return {
    items,
    draining: false,
    lastEnqueuedAt: Date.now(),
    mode: "followup",
    debounceMs: 1000,
    cap: 20,
    dropPolicy: "summarize",
    droppedCount: 0,
    summaryLines: [],
  };
}

describe("persistFollowupQueues", () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "persist-followups-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    FOLLOWUP_QUEUES.clear();
  });

  afterEach(async () => {
    FOLLOWUP_QUEUES.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should persist non-empty queues to disk", async () => {
    const run = makeFollowupRun();
    FOLLOWUP_QUEUES.set("queue-1", makeQueueState([run]));

    const count = await persistFollowupQueues(env);
    expect(count).toBe(1);

    const filePath = path.join(tmpDir, "pending-followups.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(data.queues).toHaveLength(1);
    expect(data.queues[0].queueKey).toBe("queue-1");
    expect(data.queues[0].items).toHaveLength(1);
    expect(data.queues[0].items[0].prompt).toBe("Hello, how are you?");
    expect(data.queues[0].items[0].sessionKey).toBe("test-session");
    expect(data.queues[0].items[0].senderId).toBe("user-1");
    // config should NOT be persisted
    expect(data.queues[0].items[0].config).toBeUndefined();
  });

  it("should skip empty queues", async () => {
    FOLLOWUP_QUEUES.set("queue-1", makeQueueState([]));

    const count = await persistFollowupQueues(env);
    expect(count).toBe(0);
  });

  it("should persist multiple queues", async () => {
    FOLLOWUP_QUEUES.set("queue-1", makeQueueState([makeFollowupRun()]));
    FOLLOWUP_QUEUES.set(
      "queue-2",
      makeQueueState([
        makeFollowupRun({ prompt: "Second message" }),
        makeFollowupRun({ prompt: "Third message" }),
      ]),
    );

    const count = await persistFollowupQueues(env);
    expect(count).toBe(3);
  });
});

describe("consumePersistedFollowups", () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "consume-followups-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return empty array when no file exists", async () => {
    const result = await consumePersistedFollowups(env);
    expect(result).toEqual([]);
  });

  it("should consume and delete the file", async () => {
    const filePath = path.join(tmpDir, "pending-followups.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        persistedAt: new Date().toISOString(),
        queues: [
          {
            queueKey: "q1",
            items: [{ prompt: "test", enqueuedAt: Date.now(), sessionKey: "s1" }],
          },
        ],
      }),
    );

    const result = await consumePersistedFollowups(env);
    expect(result).toHaveLength(1);
    expect(result[0].items[0].prompt).toBe("test");

    // File should be deleted
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("should handle malformed JSON gracefully", async () => {
    const filePath = path.join(tmpDir, "pending-followups.json");
    await fs.writeFile(filePath, "not json");

    const result = await consumePersistedFollowups(env);
    expect(result).toEqual([]);

    // File should be cleaned up
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("should handle wrong version gracefully", async () => {
    const filePath = path.join(tmpDir, "pending-followups.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 99, queues: [] }));

    const result = await consumePersistedFollowups(env);
    expect(result).toEqual([]);

    // File should be deleted after consumption
    await expect(fs.access(filePath)).rejects.toThrow();
  });
});

describe("round-trip: persist then consume", () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "roundtrip-followups-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
    FOLLOWUP_QUEUES.clear();
  });

  afterEach(async () => {
    FOLLOWUP_QUEUES.clear();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should round-trip followup items", async () => {
    const run1 = makeFollowupRun({ prompt: "Message 1", messageId: "m1" });
    const run2 = makeFollowupRun({
      prompt: "Message 2",
      messageId: "m2",
      originatingChannel: "slack",
      originatingTo: "C123",
      originatingThreadId: "ts123",
    });
    run2.run.sessionKey = "other-session";
    run2.run.senderName = "Other User";

    FOLLOWUP_QUEUES.set("q1", makeQueueState([run1]));
    FOLLOWUP_QUEUES.set("q2", makeQueueState([run2]));

    await persistFollowupQueues(env);
    const consumed = await consumePersistedFollowups(env);

    expect(consumed).toHaveLength(2);

    const q1 = consumed.find((q) => q.queueKey === "q1");
    expect(q1?.items).toHaveLength(1);
    expect(q1?.items[0].prompt).toBe("Message 1");
    expect(q1?.items[0].originatingChannel).toBe("telegram");

    const q2 = consumed.find((q) => q.queueKey === "q2");
    expect(q2?.items).toHaveLength(1);
    expect(q2?.items[0].prompt).toBe("Message 2");
    expect(q2?.items[0].originatingChannel).toBe("slack");
    expect(q2?.items[0].originatingTo).toBe("C123");
    expect(q2?.items[0].originatingThreadId).toBe("ts123");
    expect(q2?.items[0].sessionKey).toBe("other-session");
    expect(q2?.items[0].senderName).toBe("Other User");
  });
});

import {
  persistDrainRejectedMessage,
  consumeDrainRejectedMessages,
  type PersistedFollowupItem,
} from "./persist.js";

function makeDrainRejectedItem(
  overrides: Partial<PersistedFollowupItem> = {},
): PersistedFollowupItem {
  return {
    prompt: "Drain-rejected message",
    messageId: "msg-drain-1",
    enqueuedAt: Date.now(),
    originatingChannel: "telegram",
    originatingTo: "12345",
    originatingAccountId: "acc-1",
    originatingThreadId: "thread-1",
    sessionKey: "test-session",
    senderId: "user-1",
    senderName: "Test User",
    ...overrides,
  };
}

describe("persistDrainRejectedMessage", () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-rejected-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should persist a single drain-rejected message", async () => {
    const item = makeDrainRejectedItem();
    await persistDrainRejectedMessage(item, env);

    const filePath = path.join(tmpDir, "drain-rejected.jsonl");
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.prompt).toBe("Drain-rejected message");
    expect(parsed.sessionKey).toBe("test-session");
  });

  it("should append multiple messages to the same file", async () => {
    await persistDrainRejectedMessage(makeDrainRejectedItem({ prompt: "First" }), env);
    await persistDrainRejectedMessage(makeDrainRejectedItem({ prompt: "Second" }), env);
    await persistDrainRejectedMessage(makeDrainRejectedItem({ prompt: "Third" }), env);

    const filePath = path.join(tmpDir, "drain-rejected.jsonl");
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).prompt).toBe("First");
    expect(JSON.parse(lines[1]).prompt).toBe("Second");
    expect(JSON.parse(lines[2]).prompt).toBe("Third");
  });
});

describe("consumeDrainRejectedMessages", () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "consume-drain-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should return empty array when no file exists", async () => {
    const result = await consumeDrainRejectedMessages(env);
    expect(result).toEqual([]);
  });

  it("should consume and delete the file", async () => {
    const filePath = path.join(tmpDir, "drain-rejected.jsonl");
    const item = makeDrainRejectedItem();
    await fs.writeFile(filePath, JSON.stringify(item) + "\n");

    const result = await consumeDrainRejectedMessages(env);
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toBe("Drain-rejected message");

    // File should be deleted
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("should skip malformed lines gracefully", async () => {
    const filePath = path.join(tmpDir, "drain-rejected.jsonl");
    const good = makeDrainRejectedItem({ prompt: "Good" });
    await fs.writeFile(
      filePath,
      JSON.stringify(good) +
        "\nnot-json\n" +
        JSON.stringify(makeDrainRejectedItem({ prompt: "Also good" })) +
        "\n",
    );

    const result = await consumeDrainRejectedMessages(env);
    expect(result).toHaveLength(2);
    expect(result[0].prompt).toBe("Good");
    expect(result[1].prompt).toBe("Also good");
  });

  it("should handle empty lines", async () => {
    const filePath = path.join(tmpDir, "drain-rejected.jsonl");
    const item = makeDrainRejectedItem();
    await fs.writeFile(filePath, "\n" + JSON.stringify(item) + "\n\n");

    const result = await consumeDrainRejectedMessages(env);
    expect(result).toHaveLength(1);
  });
});

describe("drain-rejected round-trip", () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-roundtrip-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: tmpDir };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should round-trip drain-rejected messages", async () => {
    await persistDrainRejectedMessage(
      makeDrainRejectedItem({ prompt: "Msg 1", sessionKey: "s1" }),
      env,
    );
    await persistDrainRejectedMessage(
      makeDrainRejectedItem({ prompt: "Msg 2", sessionKey: "s2", originatingChannel: "slack" }),
      env,
    );

    const consumed = await consumeDrainRejectedMessages(env);
    expect(consumed).toHaveLength(2);
    expect(consumed[0].prompt).toBe("Msg 1");
    expect(consumed[0].sessionKey).toBe("s1");
    expect(consumed[1].prompt).toBe("Msg 2");
    expect(consumed[1].originatingChannel).toBe("slack");

    // Second consume should return empty (file deleted)
    const second = await consumeDrainRejectedMessages(env);
    expect(second).toEqual([]);
  });
});
