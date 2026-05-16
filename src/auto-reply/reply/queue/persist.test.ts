import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRestoredPendingDrainKey,
  clearRestoredPendingDrainKeysForTest,
  peekRestoredPendingDrainKeys,
  persistFollowupQueues,
  resolveFollowupQueueStatePath,
  restoreFollowupQueues,
} from "./persist.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import { getFollowupQueue } from "./state.js";
import type { QueueSettings } from "./types.js";
import type { FollowupRun } from "./types.js";

const TEST_KEY = "agent:main:dm:persist-test";
const STATE_FILE = "live-chat-followup-queues.json";

const SETTINGS: QueueSettings = {
  mode: "steer",
  debounceMs: 500,
  cap: 20,
  dropPolicy: "summarize",
};

function makeRun(): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "sess-persist",
    sessionKey: TEST_KEY,
    sessionFile: "/tmp/sess.jsonl",
    workspaceDir: "/tmp/ws",
    config: {} as FollowupRun["run"]["config"],
    provider: "anthropic",
    model: "claude",
    timeoutMs: 30000,
    blockReplyBreak: "message_end",
  };
}

function makeFollowupRun(prompt: string): FollowupRun {
  return {
    prompt,
    enqueuedAt: Date.now(),
    run: makeRun(),
    originatingChannel: "telegram",
    originatingTo: "12345",
  };
}

describe("resolveFollowupQueueStatePath", () => {
  it("resolves under the given stateDir", () => {
    expect(resolveFollowupQueueStatePath("/home/user/.openclaw/state")).toBe(
      path.join("/home/user/.openclaw/state", STATE_FILE),
    );
  });
});

describe("persistFollowupQueues / restoreFollowupQueues", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-persist-test-"));
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    FOLLOWUP_QUEUES.clear();
    clearRestoredPendingDrainKeysForTest();
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes state file when a non-empty queue exists", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("hello"));
    persistFollowupQueues();
    const statePath = path.join(tmpDir, STATE_FILE);
    expect(fs.existsSync(statePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("removes the state file when all queues are empty", () => {
    const statePath = path.join(tmpDir, STATE_FILE);
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, entries: [] }));
    expect(fs.existsSync(statePath)).toBe(true);
    persistFollowupQueues();
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("round-trips prompt and routing through persist+restore", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("queued message"));
    persistFollowupQueues();

    // Simulate a process restart: clear the in-memory map without re-persisting.
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored).toBeDefined();
    expect(restored!.items.length).toBe(1);
    expect(restored!.items[0].prompt).toBe("queued message");
    expect(restored!.items[0].originatingChannel).toBe("telegram");
    expect(restored!.items[0].originatingTo).toBe("12345");
    expect(restored!.draining).toBe(false);
  });

  it("does not restore abortSignal (runtime-only field stripped on persist)", () => {
    const controller = new AbortController();
    const run = { ...makeFollowupRun("signal test"), abortSignal: controller.signal };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(run);
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0].abortSignal).toBeUndefined();
  });

  it("is a no-op when no state file exists", () => {
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(() => restoreFollowupQueues()).not.toThrow();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
  });

  it("registers restored keys in the pending-drain set when queue has items", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("pending delivery"));
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();

    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(true);
    clearRestoredPendingDrainKey(TEST_KEY);
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
  });

  it("does not add to pending-drain set when restored queue is empty", () => {
    // Write a state file with an empty items array to verify the guard.
    const statePath = path.join(tmpDir, STATE_FILE);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        entries: [[TEST_KEY, { items: [], mode: "steer", droppedCount: 0, summaryLines: [] }]],
      }),
    );
    restoreFollowupQueues();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
  });

  it("skips entries with missing or invalid items array", () => {
    const statePath = path.join(tmpDir, STATE_FILE);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        entries: [
          ["agent:bad", { items: "not-an-array" }],
          [null, { items: [] }],
          [TEST_KEY, { items: [{ prompt: "ok", enqueuedAt: 1, run: makeRun() }], mode: "steer" }],
        ],
      }),
    );
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0].prompt).toBe("ok");
    expect(FOLLOWUP_QUEUES.get("agent:bad")).toBeUndefined();
  });
});
