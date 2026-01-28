import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../../config/sessions.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const routingMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, messageId: "mock" })),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => Boolean(channel),
  routeReply: routingMocks.routeReply,
}));

import { createFollowupRunner } from "./followup-runner.js";

beforeEach(() => {
  runEmbeddedPiAgentMock.mockReset();
  routingMocks.routeReply.mockReset();
});

const baseQueuedRun = (messageProvider = "whatsapp"): FollowupRun =>
  ({
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    originatingTo: "channel:C1",
    run: {
      sessionId: "session",
      sessionKey: "main",
      messageProvider,
      agentAccountId: "primary",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  }) as FollowupRun;

describe("createFollowupRunner compaction", () => {
  it("adds verbose auto-compaction notice and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
      }) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: false },
        });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "on",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as FollowupRun;

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    expect(onBlockReply.mock.calls[0][0].text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(1);
  });
});

describe("createFollowupRunner messaging tool dedupe", () => {
  it("drops payloads already sent via messaging tool", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["hello world!"],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers payloads when not duplicates", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses replies when a messaging tool sent via the same provider + target", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun("slack"));

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("persists usage even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-usage-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    await saveSessionStore(storePath, sessionStore);

    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun("slack"));

    expect(onBlockReply).not.toHaveBeenCalled();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.totalTokens ?? 0).toBeGreaterThan(0);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
  });
});

describe("createFollowupRunner primary routing", () => {
  it("routes followup replies to primary channel in primary-only mode", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const base = baseQueuedRun("telegram");
    const queued: FollowupRun = {
      ...base,
      originatingChannel: "imessage",
      originatingTo: "imessage:+15551234567",
      nonPrimaryNote: "RE: iMessage from Juliana | summary",
      run: {
        ...base.run,
        config: {
          routing: {
            primary: {
              mode: "primary-only",
              channel: "telegram",
              to: "telegram:me",
            },
          },
        },
      },
    };

    await runner(queued);

    expect(onBlockReply).not.toHaveBeenCalled();
    const calls = routingMocks.routeReply.mock.calls.map((call) => call[0]);
    expect(calls.some((call) => call.channel === "telegram")).toBe(true);
    expect(calls.some((call) => call.channel === "imessage")).toBe(false);
    const primaryPayload = calls.find((call) => call.channel === "telegram")?.payload;
    expect(primaryPayload?.text).toBe("RE: iMessage from Juliana | summary\n\nhello");
  });

  it("mirrors followup replies to source and primary in mirror mode", async () => {
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const base = baseQueuedRun("telegram");
    const queued: FollowupRun = {
      ...base,
      originatingChannel: "imessage",
      originatingTo: "imessage:+15551234567",
      nonPrimaryNote: "RE: iMessage from Juliana | summary",
      run: {
        ...base.run,
        config: {
          routing: {
            primary: {
              mode: "mirror",
              channel: "telegram",
              to: "telegram:me",
            },
          },
        },
      },
    };

    await runner(queued);

    expect(onBlockReply).not.toHaveBeenCalled();
    const calls = routingMocks.routeReply.mock.calls.map((call) => call[0]);
    expect(calls.some((call) => call.channel === "telegram")).toBe(true);
    expect(calls.some((call) => call.channel === "imessage")).toBe(true);
  });
});
