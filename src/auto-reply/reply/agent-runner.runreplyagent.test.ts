import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import * as sessions from "../../config/sessions.js";
import { DEFAULT_MEMORY_FLUSH_PROMPT } from "./memory-flush.js";
import { createMockTypingController } from "./test-helpers.js";

type AgentRunParams = {
  onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
  onAssistantMessageStart?: () => Promise<void> | void;
  onReasoningStream?: (payload: { text?: string }) => Promise<void> | void;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
};

type EmbeddedRunParams = {
  prompt?: string;
  extraSystemPrompt?: string;
  onAgentEvent?: (evt: { stream?: string; data?: { phase?: string; willRetry?: boolean } }) => void;
};

const state = vi.hoisted(() => ({
  runEmbeddedPiAgentMock: vi.fn(),
  runCliAgentMock: vi.fn(),
}));

let runReplyAgentPromise:
  | Promise<(typeof import("./agent-runner.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("./agent-runner.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

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
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (params: unknown) => state.runCliAgentMock(params),
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

beforeAll(async () => {
  // Avoid attributing the initial agent-runner import cost to the first test case.
  await getRunReplyAgent();
});

beforeEach(() => {
  state.runEmbeddedPiAgentMock.mockReset();
  state.runCliAgentMock.mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

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
    run: async () => {
      const runReplyAgent = await getRunReplyAgent();
      return runReplyAgent({
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
      });
    },
  };
}

async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  entry: Record<string, unknown>;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
    "utf-8",
  );
}

function createBaseRun(params: {
  storePath: string;
  sessionEntry: Record<string, unknown>;
  config?: Record<string, unknown>;
  runOverrides?: Partial<FollowupRun["run"]>;
}) {
  const typing = createMockTypingController();
  const sessionCtx = {
    Provider: "whatsapp",
    OriginatingTo: "+15550001111",
    AccountId: "primary",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: params.config ?? {},
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
  } as unknown as FollowupRun;
  const run = {
    ...followupRun.run,
    ...params.runOverrides,
    config: params.config ?? followupRun.run.config,
  };

  return {
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun: { ...followupRun, run },
  };
}

async function runReplyAgentWithBase(params: {
  baseRun: ReturnType<typeof createBaseRun>;
  storePath: string;
  sessionKey: string;
  sessionEntry: Record<string, unknown>;
  commandBody: string;
  typingMode?: "instant";
}): Promise<void> {
  const runReplyAgent = await getRunReplyAgent();
  const { typing, sessionCtx, resolvedQueue, followupRun } = params.baseRun;
  await runReplyAgent({
    commandBody: params.commandBody,
    followupRun,
    queueKey: params.sessionKey,
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing,
    sessionCtx,
    sessionEntry: params.sessionEntry,
    sessionStore: { [params.sessionKey]: params.sessionEntry } as Record<string, SessionEntry>,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    defaultModel: "anthropic/claude-opus-4-5",
    agentCfgContextTokens: 100_000,
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: params.typingMode ?? "instant",
  });
}

describe("runReplyAgent typing (heartbeat)", () => {
  let fixtureRoot = "";
  let caseId = 0;

  type StateEnvSnapshot = {
    OPENCLAW_STATE_DIR: string | undefined;
  };

  function snapshotStateEnv(): StateEnvSnapshot {
    return { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
  }

  function restoreStateEnv(snapshot: StateEnvSnapshot) {
    if (snapshot.OPENCLAW_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = snapshot.OPENCLAW_STATE_DIR;
    }
  }

  async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
    const stateDir = path.join(fixtureRoot, `case-${++caseId}`);
    await fs.mkdir(stateDir, { recursive: true });
    const envSnapshot = snapshotStateEnv();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      return await fn(stateDir);
    } finally {
      restoreStateEnv(envSnapshot);
    }
  }

  async function writeCorruptGeminiSessionFixture(params: {
    stateDir: string;
    sessionId: string;
    persistStore: boolean;
  }) {
    const storePath = path.join(params.stateDir, "sessions", "sessions.json");
    const sessionEntry = { sessionId: params.sessionId, updatedAt: Date.now() };
    const sessionStore = { main: sessionEntry };

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    if (params.persistStore) {
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
    }

    const transcriptPath = sessions.resolveSessionTranscriptPath(params.sessionId);
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, "bad", "utf-8");

    return { storePath, sessionEntry, sessionStore, transcriptPath };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(tmpdir(), "openclaw-typing-heartbeat-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("signals typing for normal runs", async () => {
    const onPartialReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("signals typing even without consumer partial handler", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("never signals typing for heartbeat runs", async () => {
    const onPartialReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

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
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "NO_REPLY" });
      return { payloads: [{ text: "NO_REPLY" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
      typingMode: "message",
    });
    await run();

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("does not start typing on assistant message start without prior text in message mode", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onAssistantMessageStart?.();
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("starts typing from reasoning stream in thinking mode", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onReasoningStream?.({ text: "Reasoning:\n_step_" });
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "thinking",
    });
    await run();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("suppresses typing in never mode", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "never",
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("signals typing on normalized block replies", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.({ text: "\n\nchunk", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

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
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onToolResult?.({ text: "tooling", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

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
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onToolResult?.({ text: "NO_REPLY", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("announces auto-compaction in verbose mode and tracks count", async () => {
    await withTempStateDir(async (stateDir) => {
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId: "session", updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: false },
        });
        return { payloads: [{ text: "final" }], meta: {} };
      });

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
  });

  it("retries after compaction failure by resetting the session", async () => {
    await withTempStateDir(async (stateDir) => {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error(
          'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        );
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Context limit exceeded during compaction"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    });
  });

  it("retries after context overflow payload by resetting the session", async () => {
    await withTempStateDir(async (stateDir) => {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
        payloads: [{ text: "Context overflow: prompt too large", isError: true }],
        meta: {
          durationMs: 1,
          error: {
            kind: "context_overflow",
            message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
          },
        },
      }));

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Context limit exceeded"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    });
  });

  it("resets the session after role ordering payloads", async () => {
    await withTempStateDir(async (stateDir) => {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
        payloads: [{ text: "Message ordering conflict - please try again.", isError: true }],
        meta: {
          durationMs: 1,
          error: {
            kind: "role_ordering",
            message: 'messages: roles must alternate between "user" and "assistant"',
          },
        },
      }));

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Message ordering conflict"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);
      await expect(fs.access(transcriptPath)).rejects.toBeDefined();

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    });
  });

  it("resets corrupted Gemini sessions and deletes transcripts", async () => {
    await withTempStateDir(async (stateDir) => {
      const { storePath, sessionEntry, sessionStore, transcriptPath } =
        await writeCorruptGeminiSessionFixture({
          stateDir,
          sessionId: "session-corrupt",
          persistStore: true,
        });

      state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
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
    });
  });

  it("keeps sessions intact on other errors", async () => {
    await withTempStateDir(async (stateDir) => {
      const sessionId = "session-ok";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
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
    });
  });

  it("still replies even if session reset fails to persist", async () => {
    await withTempStateDir(async (stateDir) => {
      const saveSpy = vi
        .spyOn(sessions, "saveSessionStore")
        .mockRejectedValueOnce(new Error("boom"));
      try {
        const { storePath, sessionEntry, sessionStore, transcriptPath } =
          await writeCorruptGeminiSessionFixture({
            stateDir,
            sessionId: "session-corrupt",
            persistStore: false,
          });

        state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
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
      }
    });
  });

  it("returns friendly message for role ordering errors thrown as exceptions", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      throw new Error("400 Incorrect role information");
    });

    const { run } = createMinimalRun({});
    const res = await run();

    expect(res).toMatchObject({
      text: expect.stringContaining("Message ordering conflict"),
    });
    expect(res).toMatchObject({
      text: expect.not.stringContaining("400"),
    });
  });

  it("returns friendly message for 'roles must alternate' errors thrown as exceptions", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      throw new Error('messages: roles must alternate between "user" and "assistant"');
    });

    const { run } = createMinimalRun({});
    const res = await run();

    expect(res).toMatchObject({
      text: expect.stringContaining("Message ordering conflict"),
    });
  });

  it("rewrites Bun socket errors into friendly text", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
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
    expect(payloads[0]?.text).toContain("socket connection was closed unexpectedly");
    expect(payloads[0]?.text).toContain("```");
  });
});

describe("runReplyAgent memory flush", () => {
  let fixtureRoot = "";
  let caseId = 0;

  async function withTempStore<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
    const dir = path.join(fixtureRoot, `case-${++caseId}`);
    await fs.mkdir(dir, { recursive: true });
    return await fn(path.join(dir, "sessions.json"));
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(tmpdir(), "openclaw-memory-flush-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function expectMemoryFlushSkippedWithWorkspaceAccess(
    workspaceAccess: "ro" | "none",
  ): Promise<void> {
    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      const calls: Array<{ prompt?: string }> = [];
      state.runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
        calls.push({ prompt: params.prompt });
        return {
          payloads: [{ text: "ok" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      });

      const baseRun = createBaseRun({
        storePath,
        sessionEntry,
        config: {
          agents: {
            defaults: {
              sandbox: { mode: "all", workspaceAccess },
            },
          },
        },
      });

      await runReplyAgentWithBase({
        baseRun,
        storePath,
        sessionKey,
        sessionEntry,
        commandBody: "hello",
      });

      expect(calls.map((call) => call.prompt)).toEqual(["hello"]);

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(stored[sessionKey].memoryFlushAt).toBeUndefined();
    });
  }

  it("skips memory flush for CLI providers", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      state.runEmbeddedPiAgentMock.mockImplementation(async () => ({
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      }));
      state.runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      });

      const baseRun = createBaseRun({
        storePath,
        sessionEntry,
        runOverrides: { provider: "codex-cli" },
      });

      await runReplyAgentWithBase({
        baseRun,
        storePath,
        sessionKey,
        sessionEntry,
        commandBody: "hello",
      });

      expect(state.runCliAgentMock).toHaveBeenCalledTimes(1);
      const call = state.runCliAgentMock.mock.calls[0]?.[0] as { prompt?: string } | undefined;
      expect(call?.prompt).toBe("hello");
      expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });

  it("uses configured prompts for memory flush runs", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      const calls: Array<EmbeddedRunParams> = [];
      state.runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
        calls.push(params);
        if (params.prompt === DEFAULT_MEMORY_FLUSH_PROMPT) {
          return { payloads: [], meta: {} };
        }
        return {
          payloads: [{ text: "ok" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      });

      const baseRun = createBaseRun({
        storePath,
        sessionEntry,
        config: {
          agents: {
            defaults: {
              compaction: {
                memoryFlush: {
                  prompt: "Write notes.",
                  systemPrompt: "Flush memory now.",
                },
              },
            },
          },
        },
        runOverrides: { extraSystemPrompt: "extra system" },
      });

      await runReplyAgentWithBase({
        baseRun,
        storePath,
        sessionKey,
        sessionEntry,
        commandBody: "hello",
      });

      const flushCall = calls[0];
      expect(flushCall?.prompt).toContain("Write notes.");
      expect(flushCall?.prompt).toContain("NO_REPLY");
      expect(flushCall?.extraSystemPrompt).toContain("extra system");
      expect(flushCall?.extraSystemPrompt).toContain("Flush memory now.");
      expect(flushCall?.extraSystemPrompt).toContain("NO_REPLY");
      expect(calls[1]?.prompt).toBe("hello");
    });
  });

  it("runs a memory flush turn and updates session metadata", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      const calls: Array<{ prompt?: string }> = [];
      state.runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
        calls.push({ prompt: params.prompt });
        if (params.prompt === DEFAULT_MEMORY_FLUSH_PROMPT) {
          return { payloads: [], meta: {} };
        }
        return {
          payloads: [{ text: "ok" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      });

      const baseRun = createBaseRun({
        storePath,
        sessionEntry,
      });

      await runReplyAgentWithBase({
        baseRun,
        storePath,
        sessionKey,
        sessionEntry,
        commandBody: "hello",
      });

      expect(calls.map((call) => call.prompt)).toEqual([DEFAULT_MEMORY_FLUSH_PROMPT, "hello"]);

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(stored[sessionKey].memoryFlushAt).toBeTypeOf("number");
      expect(stored[sessionKey].memoryFlushCompactionCount).toBe(1);
    });
  });

  it("skips memory flush when disabled in config", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      state.runEmbeddedPiAgentMock.mockImplementation(async () => ({
        payloads: [{ text: "ok" }],
        meta: { agentMeta: { usage: { input: 1, output: 1 } } },
      }));

      const baseRun = createBaseRun({
        storePath,
        sessionEntry,
        config: { agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } },
      });

      await runReplyAgentWithBase({
        baseRun,
        storePath,
        sessionKey,
        sessionEntry,
        commandBody: "hello",
      });

      expect(state.runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const call = state.runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
        | { prompt?: string }
        | undefined;
      expect(call?.prompt).toBe("hello");

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(stored[sessionKey].memoryFlushAt).toBeUndefined();
    });
  });

  it("skips memory flush after a prior flush in the same compaction cycle", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 2,
        memoryFlushCompactionCount: 2,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      const calls: Array<{ prompt?: string }> = [];
      state.runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
        calls.push({ prompt: params.prompt });
        return {
          payloads: [{ text: "ok" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      });

      const baseRun = createBaseRun({
        storePath,
        sessionEntry,
      });

      await runReplyAgentWithBase({
        baseRun,
        storePath,
        sessionKey,
        sessionEntry,
        commandBody: "hello",
      });

      expect(calls.map((call) => call.prompt)).toEqual(["hello"]);
    });
  });

  it("skips memory flush when the sandbox workspace is read-only", async () => {
    await expectMemoryFlushSkippedWithWorkspaceAccess("ro");
  });

  it("skips memory flush when the sandbox workspace is none", async () => {
    await expectMemoryFlushSkippedWithWorkspaceAccess("none");
  });

  it("increments compaction count when flush compaction completes", async () => {
    await withTempStore(async (storePath) => {
      const sessionKey = "main";
      const sessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        compactionCount: 1,
      };

      await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

      state.runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
        if (params.prompt === DEFAULT_MEMORY_FLUSH_PROMPT) {
          params.onAgentEvent?.({
            stream: "compaction",
            data: { phase: "end", willRetry: false },
          });
          return { payloads: [], meta: {} };
        }
        return {
          payloads: [{ text: "ok" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      });

      const baseRun = createBaseRun({
        storePath,
        sessionEntry,
      });

      await runReplyAgentWithBase({
        baseRun,
        storePath,
        sessionKey,
        sessionEntry,
        commandBody: "hello",
      });

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(stored[sessionKey].compactionCount).toBe(2);
      expect(stored[sessionKey].memoryFlushCompactionCount).toBe(2);
    });
  });
});
