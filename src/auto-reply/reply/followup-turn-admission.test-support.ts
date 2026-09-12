import { afterEach, beforeEach, vi } from "vitest";
import type { FollowupRun } from "./queue.js";
import { testing } from "./reply-run-registry.test-support.js";

const state = vi.hoisted(() => ({
  admitLifecycle: vi.fn(),
  admitReply: vi.fn(),
  buildPreflightFailureText: vi.fn(),
  loadEntry: vi.fn(),
  preflight: vi.fn(),
  recheckFallbackProbe: vi.fn(),
  refreshGoal: vi.fn(),
  resolveConfig: vi.fn(),
  resolveSendPolicy: vi.fn(),
  sendPolicy: "allow" as "allow" | "deny",
  shouldNotifyCompaction: false,
}));

export function getFollowupAdmissionTestState() {
  return state;
}

vi.mock("./agent-runner-auto-fallback.js", () => ({
  resolveRunAfterAutoFallbackPrimaryProbeRecheck: (...args: unknown[]) =>
    state.recheckFallbackProbe(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: (...args: unknown[]) => state.preflight(...args),
}));

vi.mock("./agent-runner-utils.js", () => ({
  resolveQueuedReplyExecutionConfig: (...args: unknown[]) => state.resolveConfig(...args),
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));

vi.mock("./reply-turn-admission.js", () => ({
  admitReplyTurn: (...args: unknown[]) => state.admitReply(...args),
}));

vi.mock("./queue.js", () => ({
  admitFollowupRunLifecycle: (...args: unknown[]) => state.admitLifecycle(...args),
  isFollowupRunAborted: (run: FollowupRun) =>
    run.abortSignal?.aborted === true || run.queueAbortSignal?.aborted === true,
  resolveFollowupAbortSignal: (run: FollowupRun) => run.abortSignal ?? run.queueAbortSignal,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: (...args: unknown[]) => state.loadEntry(...args),
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: (...args: unknown[]) => state.resolveSendPolicy(...args),
}));

vi.mock("./inbound-meta.js", () => ({
  refreshActiveGoalContext: (...args: unknown[]) => state.refreshGoal(...args),
}));

vi.mock("./compaction-notice.js", () => ({
  createCompactionNoticePayload: ({ phase }: { phase: string }) => ({ text: phase }),
  shouldNotifyUserAboutCompaction: () => state.shouldNotifyCompaction,
}));

vi.mock("./agent-runner-failure-reply.js", () => ({
  buildPreflightCompactionFailureText: (...args: unknown[]) =>
    state.buildPreflightFailureText(...args),
}));

export const { admitFollowupTurn } = await import("./followup-turn-admission.js");

export function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "queued-session",
      sessionKey: "main",
      sessionFile: "/tmp/queued.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

export function createOperation(sessionId = "queued-session") {
  return {
    sessionId,
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    abortForRestart: vi.fn(() => true),
    retainFailureUntilComplete: vi.fn(),
    bindToolAuthoritySnapshot: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
}

export function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    typing: {} as never,
    typingMode: "never" as const,
    defaultModel: "claude",
    sessionKey: "main",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.sendPolicy = "allow";
  state.shouldNotifyCompaction = false;
  state.resolveSendPolicy.mockImplementation(() => state.sendPolicy);
  state.resolveConfig.mockImplementation(async (config) => config);
  state.buildPreflightFailureText.mockReturnValue("preflight failed");
  state.preflight.mockImplementation(async ({ sessionEntry }) => sessionEntry);
  state.recheckFallbackProbe.mockImplementation(({ run }) => run);
  state.admitLifecycle.mockResolvedValue(undefined);
  state.refreshGoal.mockImplementation((context) => context);
});

afterEach(() => {
  testing.resetReplyRunRegistry();
});
