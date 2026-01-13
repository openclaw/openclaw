import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { SessionEntry } from "../../config/sessions.js";
import * as sessions from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();

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
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./queue.js", async () => {
  const actual =
    await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

type EmbeddedPiAgentParams = {
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => Promise<void> | void;
  onAssistantMessageStart?: () => Promise<void> | void;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => Promise<void> | void;
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => Promise<void> | void;
};

function createMinimalRun(params?: {
  opts?: GetReplyOptions;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const sessionKey = params?.sessionKey ?? "main";
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: params?.resolvedVerboseLevel ?? "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;

  return {
    typing,
    opts,
    run: () =>
      runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        opts,
        typing,
        sessionEntry: params?.sessionEntry,
        sessionStore: params?.sessionStore,
        sessionKey,
        storePath: params?.storePath,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-5",
        resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
      }),
  };
}

describe("runReplyAgent typing (heartbeat)", () => {
  it("signals typing for normal runs", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("signals typing even without consumer partial handler", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("never signals typing for heartbeat runs", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("suppresses partial streaming for NO_REPLY", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onPartialReply?.({ text: "NO_REPLY" });
        return { payloads: [{ text: "NO_REPLY" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
    });
    await run();

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("starts typing on assistant message start in message mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onAssistantMessageStart?.();
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("starts typing from reasoning stream in thinking mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
        onReasoningStream?: (payload: {
          text?: string;
        }) => Promise<void> | void;
      }) => {
        await params.onReasoningStream?.({ text: "Reasoning:\n_step_" });
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "thinking",
    });
    await run();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("suppresses typing in never mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onPartialReply?: (payload: { text?: string }) => void;
      }) => {
        params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "never",
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("signals typing on block replies", async () => {
    const onBlockReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onBlockReply?.({ text: "chunk", mediaUrls: [] });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      blockStreamingEnabled: true,
      opts: { onBlockReply },
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("chunk");
    expect(onBlockReply).toHaveBeenCalled();
    const [blockPayload, blockOpts] = onBlockReply.mock.calls[0] ?? [];
    expect(blockPayload).toMatchObject({ text: "chunk", audioAsVoice: false });
    expect(blockOpts).toMatchObject({
      abortSignal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
    });
  });

  it("signals typing on tool results", async () => {
    const onToolResult = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onToolResult?.({ text: "tooling", mediaUrls: [] });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("tooling");
    expect(onToolResult).toHaveBeenCalledWith({
      text: "tooling",
      mediaUrls: [],
    });
  });

  it("skips typing for silent tool results", async () => {
    const onToolResult = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onToolResult?.({ text: "NO_REPLY", mediaUrls: [] });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("announces auto-compaction in verbose mode and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "clawdbot-compaction-")),
      "sessions.json",
    );
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore = { main: sessionEntry };

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: {
          stream: string;
          data: Record<string, unknown>;
        }) => void;
      }) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: false },
        });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run } = createMinimalRun({
      resolvedVerboseLevel: "on",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    const res = await run();
    expect(Array.isArray(res)).toBe(true);
    const payloads = res as { text?: string }[];
    expect(payloads[0]?.text).toContain("Auto-compaction complete");
    expect(payloads[0]?.text).toContain("count 1");
    expect(sessionStore.main.compactionCount).toBe(1);
  });
  it("resets corrupted Gemini sessions and deletes transcripts", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const stateDir = await fs.mkdtemp(
      path.join(tmpdir(), "clawdbot-session-reset-"),
    );
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    try {
      const sessionId = "session-corrupt";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "bad", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error(
          "function call turn comes immediately after a user turn or after a function response turn",
        );
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(res).toMatchObject({
        text: expect.stringContaining("Session history was corrupted"),
      });
      expect(sessionStore.main).toBeUndefined();
      await expect(fs.access(transcriptPath)).rejects.toThrow();

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main).toBeUndefined();
    } finally {
      if (prevStateDir) {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      } else {
        delete process.env.CLAWDBOT_STATE_DIR;
      }
    }
  });

  it("keeps sessions intact on other errors", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const stateDir = await fs.mkdtemp(
      path.join(tmpdir(), "clawdbot-session-noreset-"),
    );
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    try {
      const sessionId = "session-ok";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error("INVALID_ARGUMENT: some other failure");
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(res).toMatchObject({
        text: expect.stringContaining("Agent failed before reply"),
      });
      expect(sessionStore.main).toBeDefined();
      await expect(fs.access(transcriptPath)).resolves.toBeUndefined();

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main).toBeDefined();
    } finally {
      if (prevStateDir) {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      } else {
        delete process.env.CLAWDBOT_STATE_DIR;
      }
    }
  });

  it("retries after compaction failure by resetting the session", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const stateDir = await fs.mkdtemp(
      path.join(tmpdir(), "clawdbot-session-compaction-reset-"),
    );
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

      runEmbeddedPiAgentMock
        .mockImplementationOnce(async () => {
          throw new Error(
            'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
          );
        })
        .mockImplementationOnce(async () => ({
          payloads: [{ text: "ok" }],
          meta: {},
        }));

      const callsBefore = runEmbeddedPiAgentMock.mock.calls.length;
      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(runEmbeddedPiAgentMock.mock.calls.length - callsBefore).toBe(2);
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({ text: "ok" });
      expect(sessionStore.main.sessionId).not.toBe(sessionId);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    } finally {
      if (prevStateDir) {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      } else {
        delete process.env.CLAWDBOT_STATE_DIR;
      }
    }
  });

  it("retries after context overflow payload by resetting the session", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const stateDir = await fs.mkdtemp(
      path.join(tmpdir(), "clawdbot-session-overflow-reset-"),
    );
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

      runEmbeddedPiAgentMock
        .mockImplementationOnce(async () => ({
          payloads: [
            { text: "Context overflow: prompt too large", isError: true },
          ],
          meta: {
            durationMs: 1,
            error: {
              kind: "context_overflow",
              message:
                'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
            },
          },
        }))
        .mockImplementationOnce(async () => ({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 1 },
        }));

      const callsBefore = runEmbeddedPiAgentMock.mock.calls.length;
      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(runEmbeddedPiAgentMock.mock.calls.length - callsBefore).toBe(2);
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({ text: "ok" });
      expect(sessionStore.main.sessionId).not.toBe(sessionId);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    } finally {
      if (prevStateDir) {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      } else {
        delete process.env.CLAWDBOT_STATE_DIR;
      }
    }
  });

  it("still replies even if session reset fails to persist", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const stateDir = await fs.mkdtemp(
      path.join(tmpdir(), "clawdbot-session-reset-fail-"),
    );
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    const saveSpy = vi
      .spyOn(sessions, "saveSessionStore")
      .mockRejectedValueOnce(new Error("boom"));
    try {
      const sessionId = "session-corrupt";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "bad", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error(
          "function call turn comes immediately after a user turn or after a function response turn",
        );
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(res).toMatchObject({
        text: expect.stringContaining("Session history was corrupted"),
      });
      expect(sessionStore.main).toBeUndefined();
      await expect(fs.access(transcriptPath)).rejects.toThrow();
    } finally {
      saveSpy.mockRestore();
      if (prevStateDir) {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      } else {
        delete process.env.CLAWDBOT_STATE_DIR;
      }
    }
  });

  it("rewrites Bun socket errors into friendly text", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      payloads: [
        {
          text: "TypeError: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
          isError: true,
        },
      ],
      meta: {},
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payloads = Array.isArray(res) ? res : res ? [res] : [];
    expect(payloads.length).toBe(1);
    expect(payloads[0]?.text).toContain("LLM connection failed");
    expect(payloads[0]?.text).toContain(
      "socket connection was closed unexpectedly",
    );
    expect(payloads[0]?.text).toContain("```");
  });
});
