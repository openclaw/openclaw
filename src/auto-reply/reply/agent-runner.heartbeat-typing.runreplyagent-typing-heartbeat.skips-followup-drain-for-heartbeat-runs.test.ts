import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
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

const enqueueFollowupRunMock = vi.fn();

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

function createMinimalRun(params?: {
  opts?: GetReplyOptions;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
  isActive?: boolean;
  shouldFollowup?: boolean;
  resolvedQueueMode?: string;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = {
    mode: params?.resolvedQueueMode ?? "collect",
  } as unknown as QueueSettings;
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
        shouldFollowup: params?.shouldFollowup ?? true,
        isActive: params?.isActive ?? false,
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

describe("runReplyAgent heartbeat followup guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops heartbeat run when another run is active instead of enqueueing", async () => {
    const { run } = createMinimalRun({
      opts: { isHeartbeat: true },
      isActive: true,
      shouldFollowup: true,
    });
    const result = await run();

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("enqueues normal (non-heartbeat) run when another run is active", async () => {
    const { run } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      shouldFollowup: true,
    });
    const result = await run();

    expect(result).toBeUndefined();
    expect(enqueueFollowupRunMock).toHaveBeenCalled();
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("runs heartbeat normally when no other run is active", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      payloads: [{ text: "HEARTBEAT_OK" }],
      meta: {},
    }));

    const { run } = createMinimalRun({
      opts: { isHeartbeat: true },
      isActive: false,
      shouldFollowup: false,
    });
    const result = await run();

    expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    // Heartbeat run completes normally and returns a payload (not dropped).
    expect(result).toBeDefined();
  });
});
