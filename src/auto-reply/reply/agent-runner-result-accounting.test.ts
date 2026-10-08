import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { AdmittedFollowupTurn, FollowupRunnerParams } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import type { persistSessionUsageUpdate } from "./session-usage.js";

const mocks = vi.hoisted(() => ({
  persistSessionUsageUpdate: vi.fn(
    async (_params: Parameters<typeof persistSessionUsageUpdate>[0]) => undefined,
  ),
  refreshQueuedFollowupSession: vi.fn(),
  resolveContextTokensForModel: vi.fn<() => number | undefined>(() => 200_000),
}));

vi.mock("../../agents/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/context.js")>()),
  resolveModelContextTokenProjection: () => ({
    contextTokens: mocks.resolveContextTokensForModel(),
    authoredContextTokens: undefined,
  }),
}));

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false }),
}));

vi.mock("../../agents/live-model-switch.js", () => ({
  consolidateLiveModelSwitchAfterRun: vi.fn(async () => {}),
}));

vi.mock("../../agents/model-selection.js", () => ({
  isCliProvider: () => false,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: vi.fn(async () => {}),
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

vi.mock("./session-usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-usage.js")>()),
  persistSessionUsageUpdate: (params: Parameters<typeof persistSessionUsageUpdate>[0]) =>
    mocks.persistSessionUsageUpdate(params),
}));

import { accountFollowupTurn } from "./agent-runner-result-accounting.js";

function createParams(
  authProfileOverrideCompactionCount?: number,
): Parameters<typeof accountFollowupTurn>[0] {
  let entry: SessionEntry = {
    sessionId: "session-1",
    updatedAt: 1,
    authProfileOverride: "openai:work",
    ...(authProfileOverrideCompactionCount === undefined
      ? {}
      : { authProfileOverrideCompactionCount }),
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

  it("forwards typed runtime context provenance to session persistence", async () => {
    const params = createParams();
    const result = params.execution.execution.outcome;
    if (result.kind !== "settled") {
      throw new Error("expected settled test execution");
    }
    result.result.meta.agentMeta = {
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-4o",
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    };

    await accountFollowupTurn(params);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "codex",
        contextTokensUsed: 1_000_000,
        contextTokensSource: "runtime",
      }),
    );
  });

  it("treats a source-less current-run context window as runtime provenance", async () => {
    const params = createParams();
    const result = params.execution.execution.outcome;
    if (result.kind !== "settled") {
      throw new Error("expected settled test execution");
    }
    result.result.meta.agentMeta = {
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-4o",
      agentHarnessId: "legacy-runtime",
      contextTokens: 512_000,
    };

    await accountFollowupTurn(params);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "legacy-runtime",
        contextTokensUsed: 512_000,
        contextTokensSource: "runtime",
      }),
    );
  });

  it("marks a successful current model lookup with versioned resolved provenance", async () => {
    const params = createParams();

    await accountFollowupTurn(params);

    expect(mocks.persistSessionUsageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTokensUsed: 200_000,
        contextTokensSource: "resolved-v1",
      }),
    );
  });

  it.each([
    {
      name: "model switch",
      provider: "anthropic",
      model: "claude",
      harness: "openclaw",
      actual: "openai:work",
      locked: false,
      source: "resolved" as const,
      expected: 200_000,
      expectedSource: undefined,
    },
    {
      name: "same producing account",
      provider: "openai",
      model: "gpt-4o",
      harness: "openclaw",
      actual: "openai:work",
      locked: false,
      source: "resolved-v1" as const,
      expected: 888_000,
      expectedSource: "resolved-v1",
    },
    {
      name: "different successful account",
      provider: "openai",
      model: "gpt-4o",
      harness: "openclaw",
      actual: "openai:other",
      locked: false,
      source: "resolved-v1" as const,
      expected: 200_000,
      expectedSource: undefined,
    },
    {
      name: "locked native owner",
      provider: "openai",
      model: "gpt-4o",
      harness: "codex",
      actual: "openai:other",
      locked: true,
      source: "runtime" as const,
      expected: 888_000,
      expectedSource: "runtime",
    },
  ])(
    "qualifies a prior context fallback for $name",
    async ({ provider, model, harness, actual, locked, source, expected, expectedSource }) => {
      mocks.resolveContextTokensForModel.mockReturnValueOnce(undefined);
      const params = createParams();
      const current = params.turn.session.current();
      if (!current) {
        throw new Error("expected current test session");
      }
      params.turn.session.adopt({
        ...current,
        modelProvider: provider,
        model,
        agentHarnessId: harness,
        contextTokens: 888_000,
        contextTokensSource: source,
        modelSelectionLocked: locked,
      });
      const result = params.execution.execution.outcome;
      if (result.kind !== "settled") {
        throw new Error("expected settled test execution");
      }
      result.maintenanceAuthProfile = { authProfileId: actual };
      result.result.meta.agentMeta = {
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-4o",
        agentHarnessId: harness,
      };
      await accountFollowupTurn(params);
      const persisted = mocks.persistSessionUsageUpdate.mock.calls[0]?.[0];
      expect(persisted?.contextTokensUsed).toBe(expected);
      expect(persisted?.contextTokensSource).toBe(expectedSource);
    },
  );

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
});
