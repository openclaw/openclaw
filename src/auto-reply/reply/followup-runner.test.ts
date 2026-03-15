import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore, type SessionEntry, saveSessionStore } from "../../config/sessions.js";
import { buildCollectPrompt } from "../../utils/queue-helpers.js";
import type { FollowupRun } from "./queue/types.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const routeReplyMock = vi.fn();
const isRoutableChannelMock = vi.fn();
const applyMediaUnderstandingMock = vi.fn();

vi.mock(
  "../../agents/model-fallback.js",
  async () => await import("../../test-utils/model-fallback.mock.js"),
);

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: (params: unknown) => applyMediaUnderstandingMock(params),
}));

vi.mock("./route-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./route-reply.js")>();
  return {
    ...actual,
    isRoutableChannel: (...args: unknown[]) => isRoutableChannelMock(...args),
    routeReply: (...args: unknown[]) => routeReplyMock(...args),
  };
});

import { createFollowupRunner } from "./followup-runner.js";
import {
  applyDeferredMediaToQueuedRuns,
  buildMediaAwareQueueSummaryPrompt,
} from "./queue/drain.js";

const ROUTABLE_TEST_CHANNELS = new Set([
  "telegram",
  "slack",
  "discord",
  "signal",
  "imessage",
  "whatsapp",
  "feishu",
]);

beforeEach(() => {
  routeReplyMock.mockReset();
  routeReplyMock.mockResolvedValue({ ok: true });
  isRoutableChannelMock.mockReset();
  isRoutableChannelMock.mockImplementation((ch: string | undefined) =>
    Boolean(ch?.trim() && ROUTABLE_TEST_CHANNELS.has(ch.trim().toLowerCase())),
  );
  applyMediaUnderstandingMock.mockReset();
  applyMediaUnderstandingMock.mockResolvedValue({
    outputs: [],
    decisions: [],
    appliedImage: false,
    appliedAudio: false,
    appliedVideo: false,
    appliedFile: false,
  });
});

const baseQueuedRun = (messageProvider = "whatsapp"): FollowupRun =>
  createMockFollowupRun({ run: { messageProvider } });

const MEDIA_REPLY_HINT =
  "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths — they are blocked for security. Keep caption in the text body.";

function createQueuedRun(
  overrides: Partial<Omit<FollowupRun, "run">> & {
    run?: Partial<FollowupRun["run"]>;
  } = {},
): FollowupRun {
  return createMockFollowupRun(overrides);
}

function mockCompactionRun(params: {
  willRetry: boolean;
  result: {
    payloads: Array<{ text: string }>;
    meta: Record<string, unknown>;
  };
}) {
  runEmbeddedPiAgentMock.mockImplementationOnce(
    async (args: {
      onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
    }) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: params.willRetry, completed: true },
      });
      return params.result;
    },
  );
}

function createAsyncReplySpy() {
  return vi.fn(async () => {});
}

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

    mockCompactionRun({
      willRetry: true,
      result: { payloads: [{ text: "final" }], meta: {} },
    });

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

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(1);
  });

  it("tracks auto-compaction from embedded result metadata even when no compaction event is emitted", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-meta-")),
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

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          compactionCount: 2,
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
        },
      },
    });

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

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalled();
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(2);
  });

  it("does not count failed compaction end events in followup runs", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-failed-")),
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

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(async (args) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false, completed: false },
      });
      return {
        payloads: [{ text: "final" }],
        meta: {
          agentMeta: {
            compactionCount: 0,
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
          },
        },
      };
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toBe("final");
    expect(sessionStore.main.compactionCount).toBeUndefined();
  });
});

describe("createFollowupRunner bootstrap warning dedupe", () => {
  it("passes stored warning signature history to embedded followup runs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 1,
          projectContextChars: 0,
          nonProjectContextChars: 1,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 0,
          entries: [],
        },
        tools: {
          listChars: 0,
          schemaChars: 0,
          entries: [],
        },
        bootstrapTruncation: {
          warningMode: "once",
          warningShown: true,
          promptWarningSignature: "sig-b",
          warningSignaturesSeen: ["sig-a", "sig-b"],
          truncatedFiles: 1,
          nearLimitFiles: 0,
          totalNearLimit: false,
        },
      },
    };
    const sessionStore: Record<string, SessionEntry> = { main: sessionEntry };

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as
      | {
          bootstrapPromptWarningSignaturesSeen?: string[];
          bootstrapPromptWarningSignature?: string;
        }
      | undefined;
    expect(call?.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(call?.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});

describe("createFollowupRunner messaging tool dedupe", () => {
  function createMessagingDedupeRunner(
    onBlockReply: (payload: unknown) => Promise<void>,
    overrides: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }> = {},
  ) {
    return createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
      sessionEntry: overrides.sessionEntry,
      sessionStore: overrides.sessionStore,
      sessionKey: overrides.sessionKey,
      storePath: overrides.storePath,
    });
  }

  async function runMessagingCase(params: {
    agentResult: Record<string, unknown>;
    queued?: FollowupRun;
    runnerOverrides?: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }>;
  }) {
    const onBlockReply = createAsyncReplySpy();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...params.agentResult,
    });
    const runner = createMessagingDedupeRunner(onBlockReply, params.runnerOverrides);
    await runner(params.queued ?? baseQueuedRun());
    return { onBlockReply };
  }

  function makeTextReplyDedupeResult(overrides?: Record<string, unknown>) {
    return {
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      ...overrides,
    };
  }

  it("drops payloads already sent via messaging tool", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ text: "hello world!" }],
        messagingToolSentTexts: ["hello world!"],
      },
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers payloads when not duplicates", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: makeTextReplyDedupeResult(),
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses replies when a messaging tool sent via the same provider + target", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("suppresses replies when provider is synthetic but originating channel matches", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      },
      queued: {
        ...baseQueuedRun("heartbeat"),
        originatingChannel: "telegram",
        originatingTo: "268300329",
      } as FollowupRun,
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not suppress replies for same target when account differs", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [
          {
            tool: "telegram",
            provider: "telegram",
            to: "268300329",
            accountId: "work",
          },
        ],
      },
      queued: {
        ...baseQueuedRun("heartbeat"),
        originatingChannel: "telegram",
        originatingTo: "268300329",
        originatingAccountId: "personal",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "268300329",
        accountId: "personal",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("drops media URL from payload when messaging tool already sent it", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        messagingToolSentMediaUrls: ["/tmp/img.png"],
      },
    });

    // Media stripped → payload becomes non-renderable → not delivered.
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("delivers media payload when not a duplicate", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        messagingToolSentMediaUrls: ["/tmp/other.png"],
      },
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("persists usage even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-followup-usage-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: sessionEntry,
    };
    await saveSessionStore(storePath, sessionStore);

    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult(),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
        meta: {
          agentMeta: {
            usage: { input: 1_000, output: 50 },
            lastCallUsage: { input: 400, output: 20 },
            model: "claude-opus-4-5",
            provider: "anthropic",
          },
        },
      },
      runnerOverrides: {
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
    const store = loadSessionStore(storePath, { skipCache: true });
    // totalTokens should reflect the last call usage snapshot, not the accumulated input.
    expect(store[sessionKey]?.totalTokens).toBe(400);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
    // Accumulated usage is still stored for usage/cost tracking.
    expect(store[sessionKey]?.inputTokens).toBe(1_000);
    expect(store[sessionKey]?.outputTokens).toBe(50);
  });

  it("does not fall back to dispatcher when cross-channel origin routing fails", async () => {
    routeReplyMock.mockResolvedValueOnce({
      ok: false,
      error: "forced route failure",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("falls back to dispatcher when same-channel origin routing fails", async () => {
    routeReplyMock.mockResolvedValueOnce({
      ok: false,
      error: "outbound adapter unavailable",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun(" Feishu "),
        originatingChannel: "FEISHU",
        originatingTo: "ou_abc123",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "hello world!" }));
  });

  it("routes followups with originating account/thread metadata", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:C1",
        accountId: "work",
        threadId: "1739142736.000100",
      }),
    );
    expect(onBlockReply).not.toHaveBeenCalled();
  });
});

describe("createFollowupRunner typing cleanup", () => {
  async function runTypingCase(agentResult: Record<string, unknown>) {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...agentResult,
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());
    return typing;
  }

  function expectTypingCleanup(typing: ReturnType<typeof createMockTypingController>) {
    expect(typing.markRunComplete).toHaveBeenCalled();
    expect(typing.markDispatchIdle).toHaveBeenCalled();
  }

  it("calls both markRunComplete and markDispatchIdle on NO_REPLY", async () => {
    const typing = await runTypingCase({ payloads: [{ text: "NO_REPLY" }] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on empty payloads", async () => {
    const typing = await runTypingCase({ payloads: [] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on agent error", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("agent exploded"));

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on successful delivery", async () => {
    const typing = createMockTypingController();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalled();
    expectTypingCleanup(typing);
  });
});

describe("createFollowupRunner agentDir forwarding", () => {
  it("passes queued run agentDir to runEmbeddedPiAgent", async () => {
    runEmbeddedPiAgentMock.mockClear();
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
    const agentDir = path.join("/tmp", "agent-dir");
    const queued = createQueuedRun();
    await runner({
      ...queued,
      run: {
        ...queued.run,
        agentDir,
      },
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      agentDir?: string;
    };
    expect(call?.agentDir).toBe(agentDir);
  });
});

describe("createFollowupRunner media understanding", () => {
  it("applies audio transcription when mediaContext has untranscribed audio", async () => {
    const transcriptText = "Hello, this is a voice note.";
    // The real applyMediaUnderstanding mutates the ctx; the mock must do the same
    // so buildInboundMediaNote and queued prompt rebuilding see the transcribed body.
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nUser text:\nsome text\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Got it!" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt: "[media attached: /tmp/voice.ogg (audio/ogg)]\nsome text",
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaTypes: ["audio/ogg"],
        // MediaUnderstanding is empty — transcription not yet applied
      },
    });
    await runner(queued);

    // applyMediaUnderstanding should have been called
    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    expect(applyMediaUnderstandingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: queued.run.config,
        agentDir: queued.run.agentDir,
      }),
    );

    // The prompt passed to the agent should include the transcript, not the
    // raw audio attachment line.
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
    expect(agentCall?.prompt).not.toContain("[media attached: /tmp/voice.ogg");

    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "Got it!" }));
  });

  it("propagates the queued message provider into deferred media context", async () => {
    const transcriptText = "Provider-aware transcript";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        expect(params.ctx.Provider).toBe("telegram");
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[User sent media without caption]",
        run: { messageProvider: "telegram" },
        mediaContext: {
          Body: "",
          MediaPaths: ["/tmp/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
  });

  it("applies media understanding for URL-only attachments", async () => {
    const transcriptText = "URL-only transcript";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nUser text:\nsome text\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Got it!" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: https://cdn.example.com/voice.ogg (audio/ogg)]\nsome text",
        mediaContext: {
          Body: "some text",
          MediaUrl: "https://cdn.example.com/voice.ogg",
          MediaUrls: ["https://cdn.example.com/voice.ogg"],
          MediaType: "audio/ogg",
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
  });

  it("strips the full media line when attachment paths or URLs contain brackets", async () => {
    const transcriptText = "Bracket-safe transcript";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt:
          "[media attached: /tmp/voice[0].ogg (audio/ogg) | https://cdn.example.com/files[0].ogg]\nsome text",
        mediaContext: {
          Body: "some text",
          CommandBody: "some text",
          RawBody: "some text",
          MediaPaths: ["/tmp/voice[0].ogg"],
          MediaUrls: ["https://cdn.example.com/files[0].ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
    expect(agentCall?.prompt).not.toContain("[media attached:");
    expect(agentCall?.prompt).not.toContain("files[0].ogg]");
  });

  it("only strips leading synthetic media lines and preserves literal user text later in the prompt", async () => {
    const transcriptText = "Transcript with literal token";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = "I literally typed [media attached: keep me] in this message.";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt:
          "[media attached: /tmp/voice.ogg (audio/ogg)]\nI literally typed [media attached: keep me] in this message.",
        mediaContext: {
          Body: "I literally typed [media attached: keep me] in this message.",
          CommandBody: "I literally typed [media attached: keep me] in this message.",
          RawBody: "I literally typed [media attached: keep me] in this message.",
          MediaPaths: ["/tmp/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(
      "I literally typed [media attached: keep me] in this message.",
    );
    expect(agentCall?.prompt).not.toContain("[media attached: /tmp/voice.ogg (audio/ogg)]");
  });

  it("skips media understanding when MediaUnderstanding is already populated", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "reply" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt: "[Audio]\nTranscript:\nAlready transcribed.\n\nsome text",
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaTypes: ["audio/ogg"],
        // MediaUnderstanding already populated — transcription was applied in primary path
        MediaUnderstanding: [
          {
            kind: "audio.transcription",
            text: "Already transcribed.",
            attachmentIndex: 0,
            provider: "whisper",
          },
        ],
      },
    });
    await runner(queued);

    // Should NOT re-run media understanding
    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();

    // The original prompt should be passed through unchanged
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("Already transcribed.");
  });

  it("skips media understanding when no mediaContext is present", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "reply" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // No mediaContext (plain text message)
    const queued = createQueuedRun({ prompt: "just text" });
    await runner(queued);

    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();
  });

  it("continues with raw prompt when media understanding fails", async () => {
    applyMediaUnderstandingMock.mockRejectedValueOnce(new Error("transcription service down"));
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback reply" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const originalPrompt = "[media attached: /tmp/voice.ogg (audio/ogg)]\nsome text";
    const queued = createQueuedRun({
      prompt: originalPrompt,
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaTypes: ["audio/ogg"],
      },
    });
    await runner(queued);

    // Should have attempted media understanding
    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);

    // Agent should still run with the original prompt
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toBe(originalPrompt);

    expect(onBlockReply).toHaveBeenCalledWith(expect.objectContaining({ text: "fallback reply" }));
  });

  it("rebuilds the prompt when file extraction succeeds without media outputs", async () => {
    const fileBlock = '<file name="notes.txt" mime="text/plain">\nline one\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `some text\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "file processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/notes.txt (text/plain)]\nsome text",
        mediaContext: {
          Body: "some text",
          CommandBody: "some text",
          RawBody: "some text",
          MediaPaths: ["/tmp/notes.txt"],
          MediaTypes: ["text/plain"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("[media attached: /tmp/notes.txt (text/plain)]");
    expect(agentCall?.prompt).toContain(fileBlock);
    expect(agentCall?.prompt?.match(/<file\b/g)).toHaveLength(1);
  });

  it("preserves non-audio media lines when only audio is transcribed", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        // Simulate transcription updating the context
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: "voice transcript",
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = "voice transcript";
        params.ctx.Body = "[Audio]\nUser text:\nsome text\nTranscript:\nvoice transcript";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: "voice transcript",
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "got both" }],
      meta: {},
    });

    const onBlockReply = vi.fn(async () => {});
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt:
        "[media attached: 2 files]\n[media attached 1/2: /tmp/voice.ogg (audio/ogg)]\n[media attached 2/2: /tmp/photo.jpg (image/jpeg)]\nsome text",
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg", "/tmp/photo.jpg"],
        MediaTypes: ["audio/ogg", "image/jpeg"],
      },
    });
    await runner(queued);

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    // Audio attachment line should be stripped
    expect(agentCall?.prompt).not.toContain("voice.ogg");
    // Image attachment line should also be stripped (all media-attached lines are
    // removed and replaced by the new buildInboundMediaNote output)
    // The transcript should be present
    expect(agentCall?.prompt).toContain("voice transcript");
  });

  it("strips queued media lines when attachment paths or URLs contain a literal closing bracket", async () => {
    const transcriptText = "Bracket-safe transcript";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nUser text:\nsome text\nTranscript:\n${transcriptText}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt:
          "[media attached: /tmp/voice[0].ogg (audio/ogg) | https://cdn.example.com/files[0].ogg?sig=abc]123]\n" +
          MEDIA_REPLY_HINT +
          "\n" +
          "some text",
        mediaContext: {
          Body: "some text",
          MediaPaths: ["/tmp/voice[0].ogg"],
          MediaUrls: ["https://cdn.example.com/files[0].ogg?sig=abc]123"],
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain(transcriptText);
    expect(agentCall?.prompt).not.toContain("/tmp/voice[0].ogg");
    expect(agentCall?.prompt).not.toContain("https://cdn.example.com/files[0].ogg?sig=abc]123");
    expect(agentCall?.prompt).not.toContain(MEDIA_REPLY_HINT);
  });

  it("preserves file-only media understanding when outputs are empty", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body =
          '<file name="report.pdf" mime="application/pdf">\nQuarterly report body\n</file>';
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\n[User sent media without caption]`,
        mediaContext: {
          Body: "",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("[media attached: /tmp/report.pdf (application/pdf)]");
    expect(agentCall?.prompt).toContain(MEDIA_REPLY_HINT);
    expect(agentCall?.prompt).toContain('<file name="report.pdf" mime="application/pdf">');
    expect(agentCall?.prompt).toContain("Quarterly report body");
    expect(agentCall?.prompt).not.toContain("[User sent media without caption]");
  });

  it("replaces the queued body when inline directives were already stripped from the prompt", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body =
          '/think high summarize this\n\n<file name="report.pdf" mime="application/pdf">\nreport\n</file>';
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nsummarize this`,
        mediaContext: {
          Body: "/think high summarize this",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("summarize this");
    expect(agentCall?.prompt).toContain('<file name="report.pdf" mime="application/pdf">');
    expect(agentCall?.prompt).not.toContain("summarize this\n\n/think high summarize this");
    expect(agentCall?.prompt).not.toContain("/think high summarize this");
  });

  it("preserves directive-like tokens inside extracted media content", async () => {
    const fileBlock =
      '<file name="notes.txt" mime="text/plain">\n/model claude-opus should stay\n/queue followup should stay\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `/think high summarize this\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/notes.txt]\n${MEDIA_REPLY_HINT}\nsummarize this`,
        mediaContext: {
          Body: "/think high summarize this",
          MediaPaths: ["/tmp/notes.txt"],
          MediaTypes: ["text/plain"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("summarize this");
    expect(agentCall?.prompt).not.toContain("/think high summarize this");
    expect(agentCall?.prompt).toContain("/model claude-opus should stay");
    expect(agentCall?.prompt).toContain("/queue followup should stay");
  });

  it("rebuilds the prompt when image understanding mutates the body without outputs", async () => {
    const description = "[Image]\nDescription:\na mountain at sunset";
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = description;
        return {
          outputs: [],
          decisions: [],
          appliedImage: true,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/photo.jpg (image/jpeg)]\nsome text",
        mediaContext: {
          Body: "some text",
          MediaPaths: ["/tmp/photo.jpg"],
          MediaTypes: ["image/jpeg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("a mountain at sunset");
  });

  it("does not false-positive on user text containing literal '<file' when extracting files", async () => {
    const fileBlock = '<file name="data.csv" mime="text/csv">\ncol1,col2\n1,2\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `check my <file upload please\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "got it" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // User message contains literal "<file" text but that should NOT prevent
    // file extraction results from being embedded in the prompt.
    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/data.csv (text/csv)]\ncheck my <file upload please",
        mediaContext: {
          Body: "check my <file upload please",
          CommandBody: "check my <file upload please",
          RawBody: "check my <file upload please",
          MediaPaths: ["/tmp/data.csv"],
          MediaTypes: ["text/csv"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    // The file extraction result should be present in the prompt
    expect(agentCall?.prompt).toContain(fileBlock);
    expect(agentCall?.prompt).toContain("check my <file upload please");
  });

  it("preserves directive-like text that appears inside extracted file content", async () => {
    const fileBlock =
      '<file name="notes.txt" mime="text/plain">\nRun `/think high` literally in the shell example.\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = `summarize this\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/notes.txt]\n${MEDIA_REPLY_HINT}\nsummarize this`,
        mediaContext: {
          Body: "/think high summarize this",
          CommandBody: "summarize this",
          RawBody: "/think high summarize this",
          MediaPaths: ["/tmp/notes.txt"],
          MediaTypes: ["text/plain"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("summarize this");
    expect(agentCall?.prompt).toContain("Run `/think high` literally in the shell example.");
  });

  it("rebuilds the prompt when image understanding mutates the body without outputs", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = "some text\n\n[Image summary]\nA whiteboard with action items.";
        return {
          outputs: [],
          decisions: [],
          appliedImage: true,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[media attached: /tmp/board.jpg (image/jpeg)]\nsome text",
        mediaContext: {
          Body: "some text",
          CommandBody: "some text",
          RawBody: "some text",
          MediaPaths: ["/tmp/board.jpg"],
          MediaTypes: ["image/jpeg"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("[Image summary]");
    expect(agentCall?.prompt).toContain("A whiteboard with action items.");
  });

  it("applies media understanding for URL-only deferred attachments", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.Body = "[Audio]\nTranscript:\nremote transcript";
        params.ctx.Transcript = "remote transcript";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: "remote transcript",
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: "[User sent media without caption]",
        mediaContext: {
          Body: "",
          MediaUrl: "https://cdn.example.com/audio.ogg",
          MediaUrls: ["https://cdn.example.com/audio.ogg"],
          MediaType: "audio/ogg",
          MediaTypes: ["audio/ogg"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).toHaveBeenCalledTimes(1);
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("remote transcript");
  });

  it("uses resolved body (CommandBody) as originalBody for accurate prompt replacement", async () => {
    const fileBlock = '<file name="report.pdf" mime="application/pdf">\nreport content\n</file>';
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        // applyMediaUnderstanding mutates the resolved body (which is CommandBody)
        params.ctx.Body = `summarize this\n\n${fileBlock}`;
        return {
          outputs: [],
          decisions: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // Body has directive prefix; CommandBody has the cleaned version.
    // The prompt was built from CommandBody, so originalBody should match CommandBody
    // for accurate replacement.
    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nsummarize this`,
        mediaContext: {
          Body: "/think high summarize this",
          CommandBody: "summarize this",
          RawBody: "/think high summarize this",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    // File block should be present (extraction succeeded)
    expect(agentCall?.prompt).toContain(fileBlock);
    // The body text should appear once, not duplicated
    expect(agentCall?.prompt).toContain("summarize this");
    // Should NOT contain the directive prefix
    expect(agentCall?.prompt).not.toContain("/think high");
    // The body should not be duplicated (would happen if originalBody didn't match)
    const matches = agentCall?.prompt?.match(/summarize this/g);
    expect(matches?.length).toBe(1);
  });

  it("does not duplicate file blocks for mixed audio+file messages re-processed in followup", async () => {
    const existingFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nold extracted content\n</file>';
    const newFileBlock =
      '<file name="report.pdf" mime="application/pdf">\nnew extracted content\n</file>';
    const transcriptText = "Mixed message transcript";

    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: transcriptText,
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = transcriptText;
        params.ctx.Body = `[Audio]\nTranscript:\n${transcriptText}\n\nanalyze this\n\n${newFileBlock}`;
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: transcriptText,
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: true,
        };
      },
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    // Simulate a mixed message where the primary path already extracted the
    // PDF (file block is in the prompt) but audio transcription failed.
    await runner(
      createQueuedRun({
        prompt: `[media attached 1/2: /tmp/voice.ogg]\n[media attached 2/2: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nanalyze this\n\n${existingFileBlock}`,
        mediaContext: {
          Body: `analyze this\n\n${existingFileBlock}`,
          CommandBody: "analyze this",
          RawBody: "analyze this",
          MediaPaths: ["/tmp/voice.ogg", "/tmp/report.pdf"],
          MediaTypes: ["audio/ogg", "application/pdf"],
        },
      }),
    );

    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    // Should contain the transcript
    expect(agentCall?.prompt).toContain(transcriptText);
    // Should have exactly one file block (the new one), not two
    expect(agentCall?.prompt?.match(/<file\s+name="report\.pdf"/g)).toHaveLength(1);
    expect(agentCall?.prompt).toContain("new extracted content");
    expect(agentCall?.prompt).not.toContain("old extracted content");
  });

  it("sets DeferredMediaApplied when media understanding throws", async () => {
    applyMediaUnderstandingMock.mockRejectedValueOnce(
      new Error("transcription service unavailable"),
    );
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "fallback reply" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    const queued = createQueuedRun({
      prompt: "[media attached: /tmp/voice.ogg (audio/ogg)]\nsome text",
      mediaContext: {
        Body: "some text",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaTypes: ["audio/ogg"],
      },
    });

    await runner(queued);

    // DeferredMediaApplied should be set so re-runs don't retry
    expect(queued.mediaContext?.DeferredMediaApplied).toBe(true);

    // The agent should still be called with the raw prompt
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt).toContain("some text");
  });

  it("does not re-apply file extraction when the stored media body already has a file block", async () => {
    const fileBlock = '<file name="report.pdf" mime="application/pdf">\nreport content\n</file>';
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "processed" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-5",
    });

    await runner(
      createQueuedRun({
        prompt: `[media attached: /tmp/report.pdf]\n${MEDIA_REPLY_HINT}\nsummarize this\n\n${fileBlock}`,
        mediaContext: {
          Body: `summarize this\n\n${fileBlock}`,
          CommandBody: "summarize this",
          RawBody: "summarize this",
          MediaPaths: ["/tmp/report.pdf"],
          MediaTypes: ["application/pdf"],
        },
      }),
    );

    expect(applyMediaUnderstandingMock).not.toHaveBeenCalled();
    const agentCall = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as {
      prompt?: string;
    };
    expect(agentCall?.prompt?.match(/<file\s+name="report\.pdf"/g)).toHaveLength(1);
  });
});

describe("followup queue drain deferred media understanding", () => {
  it("preprocesses collect batches before synthesizing the followup prompt", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: "collect transcript",
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = "collect transcript";
        params.ctx.Body = "[Audio]\nTranscript:\ncollect transcript";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: "collect transcript",
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    const items: FollowupRun[] = [
      createQueuedRun({
        prompt: "[media attached: /tmp/voice.ogg (audio/ogg)]\nsome text",
        summaryLine: "some text",
        originatingChannel: "telegram",
        originatingTo: "chat:1",
        run: { messageProvider: "telegram" },
        mediaContext: {
          Body: "some text",
          MediaPaths: ["/tmp/voice.ogg"],
          MediaTypes: ["audio/ogg"],
        },
      }),
      createQueuedRun({
        prompt: "second text",
        summaryLine: "second text",
        originatingChannel: "telegram",
        originatingTo: "chat:1",
        run: { messageProvider: "telegram" },
      }),
    ];

    await applyDeferredMediaToQueuedRuns(items);

    const prompt = buildCollectPrompt({
      title: "[Queued messages while agent was busy]",
      items,
      renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
    });

    expect(prompt).toContain("collect transcript");
    expect(prompt).toContain("Queued #2\nsecond text");
    expect(prompt).not.toContain("[media attached: /tmp/voice.ogg");
  });

  it("preprocesses dropped media items before building overflow summaries", async () => {
    applyMediaUnderstandingMock.mockImplementationOnce(
      async (params: { ctx: Record<string, unknown> }) => {
        params.ctx.MediaUnderstanding = [
          {
            kind: "audio.transcription",
            text: "overflow transcript",
            attachmentIndex: 0,
            provider: "whisper",
          },
        ];
        params.ctx.Transcript = "overflow transcript";
        params.ctx.Body = "[Audio]\nTranscript:\noverflow transcript";
        return {
          outputs: [
            {
              kind: "audio.transcription",
              text: "overflow transcript",
              attachmentIndex: 0,
              provider: "whisper",
            },
          ],
          decisions: [],
          appliedImage: false,
          appliedAudio: true,
          appliedVideo: false,
          appliedFile: false,
        };
      },
    );
    const summaryPrompt = await buildMediaAwareQueueSummaryPrompt({
      dropPolicy: "summarize",
      droppedCount: 1,
      summaryLines: ["[media attached: /tmp/voice.ogg (audio/ogg)]"],
      summaryItems: [
        createQueuedRun({
          prompt: "[media attached: /tmp/voice.ogg (audio/ogg)]",
          summaryLine: "",
          run: { messageProvider: "telegram" },
          mediaContext: {
            Body: "",
            MediaPaths: ["/tmp/voice.ogg"],
            MediaTypes: ["audio/ogg"],
          },
        }),
      ],
      noun: "message",
    });

    expect(summaryPrompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(summaryPrompt).toContain("overflow transcript");
    expect(summaryPrompt).not.toContain("[media attached: /tmp/voice.ogg");
  });
});
