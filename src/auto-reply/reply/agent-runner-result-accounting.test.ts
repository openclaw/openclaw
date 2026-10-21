import { beforeEach, expect, it, vi } from "vitest";
import { useAccountingFixture } from "./agent-runner-accounting.test-support.js";

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

const { createFixture } = useAccountingFixture("openclaw-accounting-pin-");

beforeEach(() => vi.clearAllMocks());

it.each([
  [undefined, "user"],
  [0, "auto"],
] as const)(
  "forwards a source-less pin with compaction count %s as %s during fallback queue refresh",
  async (authProfileOverrideCompactionCount, expectedSource) => {
    const fixture = await createFixture();
    Object.assign(fixture.context.followupRun.run, { provider: "anthropic", model: "claude" });
    fixture.context.execution.resolved = { provider: "openai", model: "gpt-4o" };
    fixture.context.execution.fallback.attempts = [
      { provider: "anthropic", model: "claude", error: "rate limited", reason: "rate_limit" },
    ];
    await fixture.patch({
      authProfileOverride: "openai:work",
      authProfileOverrideCompactionCount,
    });
    await fixture.account("followup", { provider: "openai", model: "gpt-4o" });

    expect(mocks.refreshQueuedFollowupSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        key: fixture.context.sessionKey,
        nextProvider: "openai",
        nextModel: "gpt-4o",
        nextAuthProfileId: "openai:work",
        nextAuthProfileIdSource: expectedSource,
      }),
    );
  },
);
