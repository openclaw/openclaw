import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../auto-reply/reply/queue/build-followup-run.js", () => ({
  buildFollowupRunForSession: vi.fn(),
}));
vi.mock("../../auto-reply/reply/queue/enqueue.js", () => ({
  enqueueFollowupRun: vi.fn(),
}));
vi.mock("../../auto-reply/reply/queue/drain.js", () => ({
  kickFollowupDrainIfIdle: vi.fn(),
  rememberFollowupDrainCallback: vi.fn(),
}));
vi.mock("../../auto-reply/reply/queue/state.js", () => ({
  getExistingFollowupQueue: vi.fn(),
}));
vi.mock("../../auto-reply/reply/followup-runner.js", () => ({
  createFollowupRunner: vi.fn(),
}));
vi.mock("../../auto-reply/reply/typing.js", () => ({
  createTypingController: vi.fn(),
}));
vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn() },
}));
vi.mock("../../agents/defaults.js", () => ({
  DEFAULT_MODEL: "gpt-5.4",
}));
vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
}));

import { createFollowupRunner } from "../../auto-reply/reply/followup-runner.js";
import { buildFollowupRunForSession } from "../../auto-reply/reply/queue/build-followup-run.js";
import {
  kickFollowupDrainIfIdle,
  rememberFollowupDrainCallback,
} from "../../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { getExistingFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { createTypingController } from "../../auto-reply/reply/typing.js";
import { createRuntimeFollowup } from "./runtime-followup.js";

const SESSION_KEY = "agent:main:telegram:direct:123:thread:123:456";

function makeFollowupRun() {
  const sessionEntry = {
    sessionId: "session-abc",
    lastChannel: "telegram",
    lastTo: "12345",
    chatType: "direct",
  };
  return {
    prompt: "continue",
    enqueuedAt: Date.now(),
    _sessionMeta: {
      storePath: "/tmp/custom-sessions.json",
      sessionStore: { [SESSION_KEY]: sessionEntry },
      sessionEntry,
    },
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-abc",
      sessionKey: SESSION_KEY,
      sessionFile: "/tmp/session-abc.jsonl",
      workspaceDir: "/tmp/workspace",
      config: { session: { store: "/tmp/custom-sessions.json" } },
      provider: "anthropic",
      model: "claude-opus-4-6",
      timeoutMs: 300_000,
      blockReplyBreak: "text_end" as const,
      senderIsOwner: true,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  const mockTypingController = {};
  (createTypingController as ReturnType<typeof vi.fn>).mockReturnValue(mockTypingController);

  const mockRunner = { run: vi.fn() };
  (createFollowupRunner as ReturnType<typeof vi.fn>).mockReturnValue(mockRunner);

  // Default: no existing queue
  (getExistingFollowupQueue as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  // Default: enqueue succeeds
  (enqueueFollowupRun as ReturnType<typeof vi.fn>).mockReturnValue(true);
  // Default: followup run built successfully (includes _sessionMeta)
  (buildFollowupRunForSession as ReturnType<typeof vi.fn>).mockResolvedValue(makeFollowupRun());
});

describe("createRuntimeFollowup", () => {
  it("returns false when session not found", async () => {
    (buildFollowupRunForSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const followup = createRuntimeFollowup();
    const result = await followup.enqueueFollowupTurn({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });

    expect(result).toBe(false);
    expect(enqueueFollowupRun).not.toHaveBeenCalled();
  });

  it("returns true and enqueues run on happy path (cold session defaults to followup mode)", async () => {
    // Cold session: no existing queue
    (getExistingFollowupQueue as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const followup = createRuntimeFollowup();
    const result = await followup.enqueueFollowupTurn({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });

    expect(result).toBe(true);
    expect(enqueueFollowupRun).toHaveBeenCalledWith(
      SESSION_KEY,
      expect.objectContaining({ prompt: "continue" }),
      { mode: "followup" },
      "none",
      undefined,
      false,
    );
  });

  it("preserves existing queue mode instead of forcing followup", async () => {
    // Hot session with "collect" mode already set
    (getExistingFollowupQueue as ReturnType<typeof vi.fn>).mockReturnValue({
      mode: "collect",
      draining: true,
    });

    const followup = createRuntimeFollowup();
    const result = await followup.enqueueFollowupTurn({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });

    expect(result).toBe(true);
    expect(enqueueFollowupRun).toHaveBeenCalledWith(
      SESSION_KEY,
      expect.objectContaining({ prompt: "continue" }),
      { mode: "collect" },
      "none",
      undefined,
      false,
    );
  });

  it("uses existing drain callback for hot sessions (kickFollowupDrainIfIdle started drain)", async () => {
    // Simulate hot session: after kick, queue shows draining=true
    (getExistingFollowupQueue as ReturnType<typeof vi.fn>).mockReturnValue({ draining: true });

    const followup = createRuntimeFollowup();
    const result = await followup.enqueueFollowupTurn({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });

    expect(result).toBe(true);
    // Should kick but NOT register a new callback (hot session handled by existing runner)
    expect(kickFollowupDrainIfIdle).toHaveBeenCalledWith(SESSION_KEY);
    expect(rememberFollowupDrainCallback).not.toHaveBeenCalled();
  });

  it("creates fresh runner for cold sessions when queue not draining", async () => {
    // Cold session: queue exists but not draining
    (getExistingFollowupQueue as ReturnType<typeof vi.fn>).mockReturnValue({ draining: false });

    const followup = createRuntimeFollowup();
    const result = await followup.enqueueFollowupTurn({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });

    expect(result).toBe(true);
    // Should register fresh runner and kick again
    expect(rememberFollowupDrainCallback).toHaveBeenCalled();
    expect(kickFollowupDrainIfIdle).toHaveBeenCalledTimes(2);
  });

  it("passes session metadata from _sessionMeta into cold followup runner", async () => {
    (getExistingFollowupQueue as ReturnType<typeof vi.fn>).mockReturnValue({ draining: false });

    // _sessionMeta is provided by buildFollowupRunForSession (via makeFollowupRun)
    // so runtime-followup no longer calls resolveStorePath/loadSessionStore directly.
    const followup = createRuntimeFollowup();
    const result = await followup.enqueueFollowupTurn({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });

    expect(result).toBe(true);
    // Verify session metadata from _sessionMeta flows into the cold runner
    expect(createFollowupRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({ sessionId: "session-abc" }),
        sessionStore: expect.objectContaining({ [SESSION_KEY]: expect.any(Object) }),
        sessionKey: SESSION_KEY,
        storePath: "/tmp/custom-sessions.json",
        defaultModel: "claude-opus-4-6",
      }),
    );
  });

  it("catches errors and returns false", async () => {
    (buildFollowupRunForSession as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("session store unavailable"),
    );

    const followup = createRuntimeFollowup();
    const result = await followup.enqueueFollowupTurn({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });

    expect(result).toBe(false);
  });
});
