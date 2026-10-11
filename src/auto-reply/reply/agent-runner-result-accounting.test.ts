import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";

const mocks = vi.hoisted(() => ({
  refreshQueuedFollowupSession: vi.fn(),
  resolveContextTokensForModel: vi.fn<() => number | undefined>(() => 200_000),
}));

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => mocks.resolveContextTokensForModel(),
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false }),
}));

vi.mock("../../agents/model-selection.js", () => ({
  isCliProvider: () => false,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../sessions/input-provenance.js", () => ({
  shouldPreserveUserFacingSessionStateForInputProvenance: () => false,
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
  resolveFallbackOriginModel: () => ({
    provider: "anthropic",
    model: "claude",
  }),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) => mocks.refreshQueuedFollowupSession(...args),
}));

vi.mock("./reply-usage-state.js", () => ({
  buildReplyUsageState: () => ({}),
  recordReplyUsageState: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn(async () => undefined),
}));

import { accountFollowupTurn } from "./agent-runner-result-accounting.js";

function createParams(
  authProfileOverrideCompactionCount?: number,
  selection: Partial<SessionEntry> = {},
): Parameters<typeof accountFollowupTurn>[0] {
  let entry: SessionEntry = {
    sessionId: "session-1",
    updatedAt: 1,
    authProfileOverride: "openai:work",
    ...(authProfileOverrideCompactionCount === undefined
      ? {}
      : { authProfileOverrideCompactionCount }),
    ...selection,
  };
  const sessionStore = { main: entry };
  const turn = {
    runId: "run-1",
    queued: {
      prompt: "queued prompt",
      enqueuedAt: 1,
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session-1",
        sessionKey: "main",
        sessionFile: "main",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {},
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => entry,
      publish: (next: SessionEntry | undefined) => {
        if (next) {
          entry = next;
          sessionStore.main = next;
        }
      },
      adopt: (next: SessionEntry) => {
        entry = next;
        sessionStore.main = next;
      },
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
        didLogHeartbeatStrip: false,
      },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: {
      drain: vi.fn(async () => {}),
    },
  } as FollowupExecutionResult;
  return { turn, defaults, execution };
}

describe("accountFollowupTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveContextTokensForModel.mockReturnValue(200_000);
  });

  it.each([
    {
      name: "source-less legacy user pin",
      authProfileOverrideCompactionCount: undefined,
      expectedSource: "user",
    },
    {
      name: "source-less compaction-marked auto pin",
      authProfileOverrideCompactionCount: 0,
      expectedSource: "auto",
    },
  ] as const)(
    "forwards a $name with canonical provenance during fallback queue refresh",
    async ({ authProfileOverrideCompactionCount, expectedSource }) => {
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

  it.each([
    { name: "keeps", persistedPolicy: "configured", expected: "configured" },
    { name: "withdraws", persistedPolicy: undefined, expected: undefined },
  ] as const)(
    "$name persisted fallback consent on queued work after a fallback transition",
    async ({ persistedPolicy, expected }) => {
      const queueState =
        await vi.importActual<typeof import("./queue/state.js")>("./queue/state.js");
      mocks.refreshQueuedFollowupSession.mockImplementationOnce(
        queueState.refreshQueuedFollowupSession,
      );
      const params = createParams(undefined, {
        providerOverride: "anthropic",
        modelOverride: "claude",
        modelOverrideSource: "user",
        modelFallbackPolicy: persistedPolicy,
      });
      const queue = queueState.getFollowupQueue("main", { mode: "followup" });
      onTestFinished(() => {
        queueState.clearFollowupQueue("main");
      });
      const waiting = {
        ...params.turn.queued.run,
        hasSessionModelOverride: true,
        modelOverrideSource: "user" as const,
        modelFallbackPolicy: "configured" as const,
      };
      queue.items.push({ prompt: "waiting prompt", enqueuedAt: 1, run: waiting });

      await accountFollowupTurn(params);

      expect(waiting).toMatchObject({ provider: "openai", model: "gpt-4o" });
      expect(waiting.modelFallbackPolicy).toBe(expected);
    },
  );
});
