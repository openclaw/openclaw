import { beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  createDefaults,
  createSettledExecution,
  createTurn,
} from "./followup-delivery.test-helpers.js";

const mocks = vi.hoisted(() => ({ refreshQueuedFollowupSession: vi.fn() }));

// mock-isolation: Queue accounting uses a fixed context limit without the process-wide model cache.
vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
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
    sessionId: "session",
    updatedAt: 1,
    authProfileOverride: "openai:work",
    authProfileOverrideCompactionCount,
  };
  const turn = createTurn({
    session: {
      kind: "session",
      key: "main",
      current: () => entry,
      publish: () => {},
    },
  });
  const execution = createSettledExecution();
  execution.outcome.resolved = { provider: "openai", model: "gpt-4o" };
  return {
    turn,
    defaults: createDefaults(async () => {}),
    execution: {
      commentaryPayloadsEnabled: false,
      execution,
      runStartedAt: 1,
      sessionCtx: {},
      pendingToolTasks: new Set(),
      progress: { drain: async () => {} },
    },
  };
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
