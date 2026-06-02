import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
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
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
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

  it("round-trips reply-target and input provenance through persist+restore", () => {
    const run = makeRun();
    run.inputProvenance = {
      kind: "external_user",
      sourceChannel: "telegram",
      sourceSessionKey: "agent:main:dm:999",
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("thread reply"),
      originatingReplyToId: "telegram-msg-99",
      run,
    });
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0].originatingReplyToId).toBe("telegram-msg-99");
    expect(restored?.items[0].run.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "telegram",
      sourceSessionKey: "agent:main:dm:999",
    });
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

  it("guards restore against split-module re-evaluation (restore-once)", () => {
    // First evaluation: state file present, restore populates the queue.
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("originally queued"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();

    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0].prompt).toBe("originally queued");

    // Simulate the drain having taken over: the queue is now mid-flight with
    // a fresh item and draining=true. A second module evaluation calling
    // restoreFollowupQueues() MUST NOT overwrite this in-flight state — that
    // would replay an already-delivered prompt or drop the fresh enqueue.
    FOLLOWUP_QUEUES.set(TEST_KEY, {
      items: [makeFollowupRun("arrived during drain")],
      draining: true,
      lastEnqueuedAt: Date.now(),
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
      droppedCount: 0,
      summaryLines: [],
      summarySources: [],
    });

    restoreFollowupQueues();
    const afterSecondRestore = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(afterSecondRestore?.items[0].prompt).toBe("arrived during drain");
    expect(afterSecondRestore?.draining).toBe(true);
  });

  it("resumes restore after the flag is explicitly cleared (test hook)", () => {
    // The forTest clear hook lets the test suite re-exercise the round-trip
    // without restarting the process. Without the clear, the second restore
    // would be a no-op and this test (and the existing round-trip tests in
    // this file) would assert against stale state.
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("first round"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0].prompt).toBe("first round");

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    // Without clearing the flag, the next restore is a no-op even though the
    // state file is still on disk and the in-memory queue is empty.
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

    // After explicitly clearing, restore runs again.
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0].prompt).toBe("first round");
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

  it("writes the state file with 0o600 permissions and no leftover temp files", () => {
    // Skip on Windows: chmod semantics differ and POSIX bit checks do not apply.
    if (process.platform === "win32") {
      return;
    }
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("private"));
    persistFollowupQueues();

    const statePath = path.join(tmpDir, STATE_FILE);
    const mode = fs.statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o600);

    const leftovers = fs
      .readdirSync(tmpDir)
      .filter((name) => name.startsWith(`${STATE_FILE}.tmp.`));
    expect(leftovers).toEqual([]);
  });

  it("replaces a pre-existing world-readable state file with a 0o600 file", () => {
    if (process.platform === "win32") {
      return;
    }
    // Simulate an install that wrote the file before the private-write fix landed.
    const statePath = path.join(tmpDir, STATE_FILE);
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, entries: [] }), { mode: 0o644 });
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o644);

    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("upgrade"));
    persistFollowupQueues();

    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("strips secret-bearing runtime fields but persists auth and reply context selectors", () => {
    const run = makeRun();
    run.config = {
      defaults: { agent: { provider: "anthropic-secret", model: "claude-secret" } },
    } as FollowupRun["run"]["config"];
    run.skillsSnapshot = {
      sensitive: "details",
    } as unknown as FollowupRun["run"]["skillsSnapshot"];
    run.extraSystemPrompt = "do-not-leak";
    run.extraSystemPromptStatic = "static-do-not-leak";
    run.authProfileId = "profile-secret";
    run.authProfileIdSource = "user";
    run.inputProvenance = {
      kind: "external_user",
      sourceChannel: "telegram",
      sourceSessionKey: "agent:main:dm:123",
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("descriptor"),
      originatingReplyToId: "msg-42",
      run,
    });
    queue.lastRun = run;
    persistFollowupQueues();

    const raw = fs.readFileSync(path.join(tmpDir, STATE_FILE), "utf8");
    for (const needle of [
      "anthropic-secret",
      "claude-secret",
      "sensitive",
      "do-not-leak",
      "static-do-not-leak",
    ]) {
      expect(raw).not.toContain(needle);
    }
    const parsed = JSON.parse(raw);
    const persistedItem = parsed.entries[0][1].items[0];
    const persistedRun = persistedItem.run;
    expect(persistedItem.originatingReplyToId).toBe("msg-42");
    expect(persistedRun.config).toBeUndefined();
    expect(persistedRun.skillsSnapshot).toBeUndefined();
    expect(persistedRun.extraSystemPrompt).toBeUndefined();
    expect(persistedRun.extraSystemPromptStatic).toBeUndefined();
    expect(persistedRun.authProfileId).toBe("profile-secret");
    expect(persistedRun.authProfileIdSource).toBe("user");
    expect(persistedRun.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "telegram",
      sourceSessionKey: "agent:main:dm:123",
    });
    const persistedLastRun = parsed.entries[0][1].lastRun;
    expect(persistedLastRun.config).toBeUndefined();
    expect(persistedLastRun.skillsSnapshot).toBeUndefined();
    expect(persistedLastRun.authProfileId).toBe("profile-secret");
    expect(persistedLastRun.authProfileIdSource).toBe("user");
    expect(persistedLastRun.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "telegram",
      sourceSessionKey: "agent:main:dm:123",
    });
  });

  it("round-trips auth profile selection through restore", () => {
    const run = makeRun();
    run.authProfileId = "anthropic:work";
    run.authProfileIdSource = "user";
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({ ...makeFollowupRun("auth-bound"), run });
    queue.lastRun = run;
    persistFollowupQueues();

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0].run.authProfileId).toBe("anthropic:work");
    expect(restored?.items[0].run.authProfileIdSource).toBe("user");
    expect(restored?.lastRun?.authProfileId).toBe("anthropic:work");
    expect(restored?.lastRun?.authProfileIdSource).toBe("user");
  });

  it("rehydrates run.config from the live runtime snapshot on restore", () => {
    // Simulate a configured gateway: the runtime snapshot is the source of
    // truth at the moment restore runs, so restored items should pick it up.
    const liveConfig = {
      defaults: { agent: { provider: "anthropic-live", model: "claude-live" } },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(liveConfig);

    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("rehydrate"));
    queue.lastRun = makeRun();
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored).toBeDefined();
    const rerun = restored!.items[0].run;
    expect(rerun.config).toBe(liveConfig);
    expect(restored!.lastRun?.config).toBe(liveConfig);
    // Other stripped fields stay undefined; the dispatcher fills them when
    // they're actually needed.
    expect(rerun.skillsSnapshot).toBeUndefined();
    expect(rerun.extraSystemPrompt).toBeUndefined();
    // inputProvenance is persisted when present on the queued run.
    expect(rerun.inputProvenance).toBeUndefined();
    // Identity / routing / paths / per-message intent survive.
    expect(rerun.agentId).toBe("main");
    expect(rerun.sessionId).toBe("sess-persist");
    expect(rerun.workspaceDir).toBe("/tmp/ws");
    expect(rerun.provider).toBe("anthropic");
    expect(rerun.model).toBe("claude");
    expect(rerun.timeoutMs).toBe(30000);
    expect(rerun.blockReplyBreak).toBe("message_end");
  });

  it("picks up a refreshed snapshot across separate restore passes", () => {
    // First persist+restore with one snapshot, then update the snapshot and
    // restore again — restored items should reflect the latest config, not
    // anything carried over from disk.
    const oldConfig = { defaults: { agent: { model: "claude-old" } } } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(oldConfig);
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("first"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)!.items[0].run.config).toBe(oldConfig);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    const newConfig = {
      defaults: { agent: { model: "claude-new" } },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(newConfig);
    // The restore-once guard would short-circuit the second pass; this test
    // models two separate process boots, so explicitly reset the flag.
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)!.items[0].run.config).toBe(newConfig);
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
