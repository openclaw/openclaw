import { beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./reply-agent-turn-preparation.js";

const mocks = vi.hoisted(() => ({ refreshQueuedFollowupSession: vi.fn() }));

// mock-isolation: Queue accounting uses a fixed context limit without the process-wide model cache.
vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false }),
}));

vi.mock("../fallback-state.js", () => ({
  resolveFallbackTransition: () => ({
    stateChanged: true,
    nextState: {
      selectedModel: "anthropic/claude",
      activeModel: "openai/gpt-4o",
      reason: "rate limit",
    },
  }),
}));

vi.mock("./agent-runner-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-core.js")>()),
  resolveFallbackOriginModel: () => ({ provider: "anthropic", model: "claude" }),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) => mocks.refreshQueuedFollowupSession(...args),
}));

vi.mock("./reply-usage-state.js", () => ({
  buildReplyUsageState: () => ({}),
  recordReplyUsageState: vi.fn(),
}));

import { accountFollowupTurn } from "./agent-runner-result-accounting.js";

function createParams(
  authProfileOverrideCompactionCount?: number,
): Parameters<typeof accountFollowupTurn>[0] {
  const entry: SessionEntry = {
    sessionId: "session-1",
    updatedAt: 1,
    authProfileOverride: "openai:work",
    authProfileOverrideCompactionCount,
  };
  const sessionStore = { main: entry };
  const turn = {
    runId: "run-1",
    queued: createQueueTestRun(
      { prompt: "queued prompt", enqueuedAt: 1 },
      {
        sessionId: "session-1",
        sessionKey: "main",
        provider: "anthropic",
        model: "claude",
      },
    ),
    operation: {},
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => sessionStore.main,
      publish: (next: SessionEntry | undefined) =>
        next && Object.assign(sessionStore, { main: next }),
    },
    sessionStore,
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  } as unknown as AdmittedFollowupTurn;
  const defaults = {
    typing: {} as FollowupRunnerParams["typing"],
    typingMode: "never",
    defaultModel: "claude",
    sessionKey: "main",
  } satisfies FollowupRunnerParams;
  const execution = {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: "run-1",
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "openai", model: "gpt-4o" },
        fallback: {
          exhausted: false,
          attempts: [
            {
              provider: "anthropic",
              model: "claude",
              error: "rate limited",
              reason: "rate_limit",
            },
          ],
        },
        autoCompactionCount: 0,
      },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: { drain: async () => {} },
  } as FollowupExecutionResult;
  return { turn, defaults, execution };
}

beforeEach(() => vi.clearAllMocks());

it.each([
  [undefined, "user"],
  [0, "auto"],
] as const)(
  "forwards a source-less pin with compaction count %s as %s during fallback queue refresh",
  async (authProfileOverrideCompactionCount, expectedSource) => {
    await accountFollowupTurn(createParams(authProfileOverrideCompactionCount));

    expect(mocks.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    expect(mocks.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "main",
        nextProvider: "openai",
        nextModel: "gpt-4o",
        nextAuthProfileId: "openai:work",
        nextAuthProfileIdSource: expectedSource,
      }),
    );
  },
);
