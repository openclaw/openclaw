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
  followupQueueEntryContainsPrompt,
  loadFollowupQueueEntries,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKey,
  clearRestoredPendingDrainKeysForTest,
  hasPersistedFollowupQueues,
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

function readPersistedQueueEntry(key: string): unknown {
  return loadFollowupQueueEntries().find(([entryKey]) => entryKey === key)?.[1];
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

  it("writes shared SQLite state when a non-empty queue exists", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("hello"));
    persistFollowupQueues();
    expect(hasPersistedFollowupQueues()).toBe(true);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(true);
    const persisted = readPersistedQueueEntry(TEST_KEY) as { items?: unknown[] };
    expect(Array.isArray(persisted?.items)).toBe(true);
  });

  it("clears shared SQLite rows when all queues are empty", () => {
    replaceFollowupQueueEntries({
      entries: [[TEST_KEY, { items: [], mode: "steer", droppedCount: 0, summaryLines: [] }]],
    });
    expect(hasPersistedFollowupQueues()).toBe(true);
    persistFollowupQueues();
    expect(hasPersistedFollowupQueues()).toBe(false);
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

  it("round-trips room_event inbound context through persist+restore", () => {
    const inboundContext = {
      text: "[OpenClaw room event]\nCurrent event:\n#42 Alice: ping",
      resumableText: "[OpenClaw room event]\nCurrent event:\n#42 Alice: ping",
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("[OpenClaw room event]"),
      transcriptPrompt: "",
      currentInboundEventKind: "room_event",
      currentInboundContext: inboundContext,
      originatingChatType: "group",
    });
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.currentInboundEventKind).toBe("room_event");
    expect(restored?.currentInboundContext).toEqual(inboundContext);
    expect(restored?.originatingChatType).toBe("group");
  });

  it("round-trips quoted reply context and inbound audio flag through persist+restore", () => {
    const inboundContext = {
      text: "Quoted:\n> prior message\n\nreplying in thread",
      promptJoiner: "\n\n" as const,
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("replying in thread"),
      transcriptPrompt: "replying in thread",
      originatingReplyToId: "msg-quote-12",
      originatingChatType: "direct",
      currentInboundAudio: true,
      currentInboundContext: inboundContext,
    });
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.originatingReplyToId).toBe("msg-quote-12");
    expect(restored?.currentInboundAudio).toBe(true);
    expect(restored?.currentInboundContext).toEqual(inboundContext);
  });

  it("round-trips bare session-reset transcript without current-turn context", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      prompt: "sender_id=telegram-user-1\nStartup context",
      transcriptPrompt: "[OpenClaw session reset]",
      enqueuedAt: Date.now(),
      run: makeRun(),
      originatingChannel: "telegram",
      originatingTo: "user-1",
    });
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.transcriptPrompt).toBe("[OpenClaw session reset]");
    expect(restored?.currentInboundContext).toBeUndefined();
    expect(restored?.currentInboundEventKind).toBeUndefined();
    expect(restored?.currentInboundAudio).toBeUndefined();
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

  it("is a no-op when no persisted queue rows exist", () => {
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(() => restoreFollowupQueues()).not.toThrow();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
  });

  it("guards restore against split-module re-evaluation (restore-once)", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("originally queued"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();

    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0].prompt).toBe("originally queued");

    FOLLOWUP_QUEUES.set(TEST_KEY, {
      abortController: new AbortController(),
      items: [makeFollowupRun("arrived during drain")],
      draining: true,
      inFlight: new Set(),
      lastEnqueuedAt: Date.now(),
      mode: "steer",
      debounceMs: 500,
      cap: 20,
      dropPolicy: "summarize",
      droppedCount: 0,
      summaryLines: [],
      summarySources: [],
      activeSummarySources: new WeakSet(),
      summaryElisions: [],
      evictedSummaryCount: 0,
    });

    restoreFollowupQueues();
    const afterSecondRestore = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(afterSecondRestore?.items[0].prompt).toBe("arrived during drain");
    expect(afterSecondRestore?.draining).toBe(true);
  });

  it("resumes restore after the flag is explicitly cleared (test hook)", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("first round"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0].prompt).toBe("first round");

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

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
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          { items: [], mode: "steer", droppedCount: 0, summaryLines: [], lastEnqueuedAt: 1 },
        ],
      ],
    });
    restoreFollowupQueues();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
  });

  it("persists queue data in shared SQLite state", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("private"));
    persistFollowupQueues();

    expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(true);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "private")).toBe(true);
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

    const entries = loadFollowupQueueEntries();
    const raw = JSON.stringify(entries);
    for (const needle of [
      "anthropic-secret",
      "claude-secret",
      "sensitive",
      "do-not-leak",
      "static-do-not-leak",
    ]) {
      expect(raw).not.toContain(needle);
    }
    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ originatingReplyToId?: string; run: Record<string, unknown> }>;
      lastRun?: Record<string, unknown>;
    };
    const persistedItem = persisted.items[0];
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
    const persistedLastRun = persisted.lastRun;
    expect(persistedLastRun?.config).toBeUndefined();
    expect(persistedLastRun?.skillsSnapshot).toBeUndefined();
    expect(persistedLastRun?.authProfileId).toBe("profile-secret");
    expect(persistedLastRun?.authProfileIdSource).toBe("user");
    expect(persistedLastRun?.inputProvenance).toEqual({
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
    expect(rerun.skillsSnapshot).toBeUndefined();
    expect(rerun.extraSystemPrompt).toBeUndefined();
    expect(rerun.inputProvenance).toBeUndefined();
    expect(rerun.agentId).toBe("main");
    expect(rerun.sessionId).toBe("sess-persist");
    expect(rerun.workspaceDir).toBe("/tmp/ws");
    expect(rerun.provider).toBe("anthropic");
    expect(rerun.model).toBe("claude");
    expect(rerun.timeoutMs).toBe(30000);
    expect(rerun.blockReplyBreak).toBe("message_end");
  });

  it("picks up a refreshed snapshot across separate restore passes", () => {
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
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)!.items[0].run.config).toBe(newConfig);
  });

  it("skips entries with missing or invalid items array", () => {
    replaceFollowupQueueEntries({
      entries: [
        ["agent:bad", { items: "not-an-array" }],
        [TEST_KEY, { items: [{ prompt: "ok", enqueuedAt: 1, run: makeRun() }], mode: "steer" }],
      ],
    });
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0].prompt).toBe("ok");
    expect(FOLLOWUP_QUEUES.get("agent:bad")).toBeUndefined();
  });
});
