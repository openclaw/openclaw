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

import { buildFollowupRunForSession } from "../../auto-reply/reply/queue/build-followup-run.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import {
  kickFollowupDrainIfIdle,
  rememberFollowupDrainCallback,
} from "../../auto-reply/reply/queue/drain.js";
import { getExistingFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { createFollowupRunner } from "../../auto-reply/reply/followup-runner.js";
import { createTypingController } from "../../auto-reply/reply/typing.js";
import { createRuntimeFollowup } from "./runtime-followup.js";

const SESSION_KEY = "agent:main:telegram:direct:123:thread:123:456";

function makeFollowupRun() {
  return {
    prompt: "continue",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-abc",
      sessionKey: SESSION_KEY,
      sessionFile: "/tmp/session-abc.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {},
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
  // Default: followup run built successfully
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

  it("returns true and enqueues run on happy path", async () => {
    // Cold session: no existing callback, queue is not draining after kick
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
