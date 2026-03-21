/**
 * Integration test: verify that pending followup queue items are persisted
 * across a simulated gateway restart cycle.
 *
 * This test exercises the full persist → consume → replay pipeline without
 * needing a running gateway or channel connections.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use a temp directory to simulate the state dir
const TEST_STATE_DIR = `/tmp/openclaw-restart-test-${Date.now()}`;

vi.mock("../src/config/paths.js", () => ({
  resolveStateDir: () => TEST_STATE_DIR,
}));

vi.mock("../src/logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Track system events for verification
const systemEvents: Array<{ text: string; sessionKey: string; contextKey?: string }> = [];

vi.mock("../src/infra/system-events.js", () => ({
  enqueueSystemEvent: (text: string, opts: { sessionKey: string; contextKey?: string }) => {
    systemEvents.push({ text, sessionKey: opts.sessionKey, contextKey: opts.contextKey });
  },
}));

const { persistFollowupQueues, consumePersistedQueues } = await import(
  "../src/auto-reply/reply/queue/persist.js"
);
const { replayPersistedPendingMessages } = await import(
  "../src/gateway/server-pending-messages.js"
);

describe("Gateway restart message persistence - integration", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_STATE_DIR, { recursive: true });
    systemEvents.length = 0;
  });

  afterEach(async () => {
    await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
  });

  it("full restart cycle: queued messages survive shutdown and are replayed on startup", async () => {
    // === PHASE 1: Simulate pre-shutdown state ===
    // A gateway has 2 sessions with pending followup messages

    const queues = new Map<
      string,
      {
        items: Array<{
          prompt: string;
          messageId?: string;
          enqueuedAt: number;
          originatingChannel?: string;
          originatingTo?: string;
          originatingAccountId?: string;
          originatingThreadId?: string | number;
          run: Record<string, unknown>;
        }>;
      }
    >();

    // Session 1: Slack channel with 2 queued messages
    queues.set("agent:main:slack:channel:C0AJJFZ6H4Z", {
      items: [
        {
          prompt: "What's the status of the eval run?",
          messageId: "1774098170.940209",
          enqueuedAt: Date.now() - 2000,
          originatingChannel: "slack",
          originatingTo: "channel:C0AJJFZ6H4Z",
          originatingAccountId: "default",
          originatingThreadId: "1774097606.802909",
          run: {
            agentId: "main",
            agentDir: "/tmp/agent",
            sessionId: "sess-slack-1",
            sessionKey: "agent:main:slack:channel:C0AJJFZ6H4Z",
            senderName: "Tom Chapin",
            senderId: "U09N5CELE6P",
            sessionFile: "/tmp/session.jsonl",
            workspaceDir: "/Users/openclaw/.openclaw/workspace",
            config: { huge: "config object that should be stripped" },
            skillsSnapshot: { big: "snapshot that should be stripped" },
            provider: "anthropic",
            model: "claude-opus-4-6",
            timeoutMs: 600000,
            blockReplyBreak: "text_end",
          },
        },
        {
          prompt: "Also can you check the Twilio number?",
          messageId: "1774098200.123456",
          enqueuedAt: Date.now() - 1000,
          originatingChannel: "slack",
          originatingTo: "channel:C0AJJFZ6H4Z",
          originatingAccountId: "default",
          originatingThreadId: "1774097606.802909",
          run: {
            agentId: "main",
            agentDir: "/tmp/agent",
            sessionId: "sess-slack-1",
            sessionKey: "agent:main:slack:channel:C0AJJFZ6H4Z",
            senderName: "Tom Chapin",
            senderId: "U09N5CELE6P",
            sessionFile: "/tmp/session.jsonl",
            workspaceDir: "/Users/openclaw/.openclaw/workspace",
            config: {},
            provider: "anthropic",
            model: "claude-opus-4-6",
            timeoutMs: 600000,
            blockReplyBreak: "text_end",
          },
        },
      ],
    });

    // Session 2: Telegram DM with 1 queued message
    queues.set("agent:main:telegram:dm:123456789", {
      items: [
        {
          prompt: "Hey Alpha, run the heartbeat",
          messageId: "tg-msg-99",
          enqueuedAt: Date.now() - 500,
          originatingChannel: "telegram",
          originatingTo: "123456789",
          originatingAccountId: "default",
          run: {
            agentId: "main",
            agentDir: "/tmp/agent",
            sessionId: "sess-tg-1",
            sessionKey: "agent:main:telegram:dm:123456789",
            senderName: "Tom",
            senderId: "tg:123456789",
            sessionFile: "/tmp/session-tg.jsonl",
            workspaceDir: "/Users/openclaw/.openclaw/workspace",
            config: {},
            provider: "anthropic",
            model: "claude-opus-4-6",
            timeoutMs: 600000,
            blockReplyBreak: "text_end",
          },
        },
      ],
    });

    // Empty session (should be skipped)
    queues.set("agent:main:discord:channel:999", {
      items: [],
    });

    // === STEP 1: Persist (simulates server-close.ts) ===
    const filePath = await persistFollowupQueues(queues as never);
    expect(filePath).toBeTruthy();

    // Verify file exists on disk
    const fileContent = await fs.readFile(filePath!, "utf-8");
    const parsed = JSON.parse(fileContent);
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(2); // Empty queue was skipped

    // Verify config was stripped
    for (const entry of parsed.entries) {
      for (const item of entry.items) {
        expect(item.run.config).toBeUndefined();
        expect(item.run.skillsSnapshot).toBeUndefined();
      }
    }

    // === STEP 2: Simulate gateway process death ===
    // (queues are now gone from memory — only the file remains)

    // === STEP 3: Replay (simulates server-startup.ts) ===
    await replayPersistedPendingMessages();

    // === VERIFICATION ===

    // System events should have been injected for both sessions
    expect(systemEvents).toHaveLength(2);

    // Find the Slack session event
    const slackEvent = systemEvents.find(
      (e) => e.sessionKey === "agent:main:slack:channel:C0AJJFZ6H4Z",
    );
    expect(slackEvent).toBeTruthy();
    expect(slackEvent!.text).toContain("Gateway restart recovery");
    expect(slackEvent!.text).toContain("2 message(s)");
    expect(slackEvent!.text).toContain("What's the status of the eval run?");
    expect(slackEvent!.text).toContain("Also can you check the Twilio number?");
    expect(slackEvent!.text).toContain("Tom Chapin");
    expect(slackEvent!.contextKey).toBe("restart-pending-messages");

    // Find the Telegram session event
    const tgEvent = systemEvents.find(
      (e) => e.sessionKey === "agent:main:telegram:dm:123456789",
    );
    expect(tgEvent).toBeTruthy();
    expect(tgEvent!.text).toContain("1 message(s)");
    expect(tgEvent!.text).toContain("Hey Alpha, run the heartbeat");

    // File should have been consumed (deleted)
    await expect(fs.access(filePath!)).rejects.toThrow();

    // Second replay should be a no-op
    systemEvents.length = 0;
    await replayPersistedPendingMessages();
    expect(systemEvents).toHaveLength(0);
  });

  it("stale messages (>5 minutes old) are discarded, not replayed", async () => {
    // Write a file that's 6 minutes old
    const filePath = path.join(TEST_STATE_DIR, "pending-messages.json");
    const staleData = {
      version: 1,
      persistedAt: Date.now() - 6 * 60 * 1000,
      entries: [
        {
          key: "agent:main:slack:channel:C123",
          items: [
            {
              prompt: "Old stale message",
              enqueuedAt: Date.now() - 7 * 60 * 1000,
              originatingChannel: "slack",
              run: { senderName: "Tom", agentId: "main" },
            },
          ],
        },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(staleData), "utf-8");

    await replayPersistedPendingMessages();

    // Should not replay stale messages
    expect(systemEvents).toHaveLength(0);
    // File should still be cleaned up
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("corrupt persistence file is handled gracefully", async () => {
    const filePath = path.join(TEST_STATE_DIR, "pending-messages.json");
    await fs.writeFile(filePath, "this is not valid json {{{{", "utf-8");

    // Should not throw
    await replayPersistedPendingMessages();
    expect(systemEvents).toHaveLength(0);
  });
});
