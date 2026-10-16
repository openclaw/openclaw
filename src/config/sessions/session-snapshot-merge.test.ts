import { describe, expect, it } from "vitest";
import {
  mergeSessionSnapshotChanges,
  projectSessionSnapshotChanges,
  sessionSnapshotTouchedFieldsConflict,
} from "./session-snapshot-merge.js";
import { mergeSessionEntry, type InternalSessionEntry as SessionEntry } from "./types.js";

const initial: SessionEntry = {
  sessionId: "session-1",
  updatedAt: 1,
  modelProvider: "anthropic",
  model: "claude-opus-4-6",
};

const interruptedAndRecoveryRuns = [
  { runId: "interrupted-run", lifecycleGeneration: "generation-1" },
  { runId: "recovery-run", lifecycleGeneration: "generation-1" },
];

const claims = (...tokens: string[]) => ({ lifecycleGeneration: "generation-1", tokens });
const runFence = (runId: string, lifecycleGeneration = "generation-1") => ({
  runId,
  lifecycleGeneration,
});
const recoveryState = (state: Partial<NonNullable<SessionEntry["mainRestartRecovery"]>> = {}) => ({
  cycleId: "cycle-1",
  revision: 1,
  chargedAttempts: 1,
  ...state,
});

function snapshot(
  entry: SessionEntry,
  updatedAt: number,
  patch: Partial<SessionEntry> = {},
): SessionEntry {
  return { ...entry, updatedAt, ...patch };
}

function modelSelection(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    ...initial,
    providerOverride: "openai",
    modelOverride: "gpt-5.4",
    modelOverrideSource: "user",
    ...overrides,
  };
}

function recovery(
  state: Partial<NonNullable<SessionEntry["mainRestartRecovery"]>> = {},
  entry: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    ...initial,
    abortedLastRun: true,
    mainRestartRecovery: recoveryState(state),
    ...entry,
  };
}

function clearedRecovery(entry: SessionEntry, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    ...entry,
    updatedAt: 2,
    abortedLastRun: false,
    mainRestartRecovery: undefined,
    ...overrides,
  };
}

describe("session snapshot merge", () => {
  it("projects same-provider model changes as an atomic pair", () => {
    const next = { ...initial, model: "claude-sonnet-4-6", updatedAt: 2 };
    const patch = projectSessionSnapshotChanges({ initial, next, current: initial });

    expect(patch).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(mergeSessionEntry(initial, patch)).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it.each([undefined, "inherit"] as const)(
    "preserves a required creation sandbox against a %s patch",
    (sandbox) => {
      expect(mergeSessionEntry({ ...initial, sandbox: "required" }, { sandbox })).toMatchObject({
        sandbox: "required",
      });
    },
  );

  it("does not add a creation sandbox to an existing unstamped session", () => {
    expect(mergeSessionEntry(initial, { sandbox: "required" })).not.toHaveProperty("sandbox");
  });

  it("retains an absent creation surface through merge and transcript rollover", () => {
    for (const createdSurface of [undefined, "plugin-dock"] as const) {
      expect(
        mergeSessionEntry(
          { ...initial, createdSurface: undefined },
          {
            sessionId: "new-transcript",
            createdSurface,
          },
        ).createdSurface,
      ).toBeUndefined();
    }
  });

  it("keeps a concurrently changed model pair", () => {
    const next = { ...initial, model: "claude-sonnet-4-6", updatedAt: 2 };
    const current = {
      ...initial,
      modelProvider: "openai",
      model: "gpt-5.5",
      updatedAt: 3,
    };

    expect(mergeSessionSnapshotChanges({ initial, next, current })).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.5",
    });
  });

  it("keeps a concurrent model and auth override family atomically", () => {
    const initialOverride: SessionEntry = {
      ...initial,
      providerOverride: "openai",
      modelOverride: "gpt-old",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-opus-4-6",
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-old",
        activeModel: "openai/gpt-fallback",
      },
    };
    const next = snapshot(initialOverride, 2, {
      providerOverride: undefined,
      modelOverride: undefined,
      modelOverrideSource: undefined,
      modelOverrideFallbackOriginProvider: undefined,
      modelOverrideFallbackOriginModel: undefined,
      authProfileOverride: undefined,
      authProfileOverrideSource: undefined,
      fallbackNotice: undefined,
      liveModelSwitchPending: true,
    });
    const current = snapshot(initialOverride, 3, {
      modelOverride: "gpt-new",
      modelOverrideSource: "user",
      authProfileOverride: "openai:user",
      authProfileOverrideSource: "user",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-new",
        activeModel: "openai/gpt-fallback",
      },
    });

    expect(mergeSessionSnapshotChanges({ initial: initialOverride, next, current })).toEqual(
      current,
    );
  });

  it("re-arms a winning explicit model switch after the prior signal clears", () => {
    const initialOverride = modelSelection({
      liveModelSwitchPending: true,
    });
    const next = { ...initialOverride, updatedAt: 2, modelOverride: "gpt-5.5" };
    const current = { ...initialOverride, updatedAt: 3 };
    delete current.liveModelSwitchPending;

    expect(
      mergeSessionSnapshotChanges({
        initial: initialOverride,
        next,
        current,
        reassertLiveModelSwitchPending: true,
      }),
    ).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
      liveModelSwitchPending: true,
    });
  });

  it("preserves concurrently consumed unchanged model-dependent state", () => {
    const initialOverride = modelSelection({
      liveModelSwitchPending: true,
      thinkingLevel: "high",
    });
    const next = { ...initialOverride, updatedAt: 2, modelOverride: "gpt-5.5" };
    const current = snapshot(initialOverride, 3, {
      thinkingLevel: "low",
    });
    delete current.liveModelSwitchPending;

    const merged = mergeSessionSnapshotChanges({ initial: initialOverride, next, current });

    expect(merged).toEqual({ ...current, modelOverride: "gpt-5.5" });
  });

  it("clears stale model-dependent state with the winning model selection", () => {
    const initialOverride = modelSelection({
      modelProvider: "openai",
      model: "gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-mini",
        reason: "rate_limit",
      },
      contextTokens: 100_000,
      contextTokensSource: "resolved",
      contextBudgetStatus: {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: 1,
        provider: "openai",
        model: "gpt-5.4",
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 10,
        contextTokenBudget: 100,
        promptBudgetBeforeReserve: 80,
        reserveTokens: 20,
        effectiveReserveTokens: 20,
        remainingPromptBudgetTokens: 70,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        messageCount: 1,
        unwindowedMessageCount: 1,
      },
    });
    const next = snapshot(initialOverride, 2, {
      modelOverride: "gpt-5.5",
      modelProvider: undefined,
      model: undefined,
      fallbackNotice: undefined,
      contextTokens: undefined,
      contextTokensSource: undefined,
      contextBudgetStatus: undefined,
    });
    const current = snapshot(initialOverride, 3, {
      modelProvider: "openai",
      model: "gpt-5.4-mini",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-nano",
      },
      contextTokens: 80_000,
      contextTokensSource: "runtime",
    });

    const merged = mergeSessionSnapshotChanges({ initial: initialOverride, next, current });

    expect(merged).toEqual({
      ...initialOverride,
      updatedAt: 3,
      modelOverride: "gpt-5.5",
      modelProvider: undefined,
      model: undefined,
      fallbackNotice: undefined,
      contextTokens: undefined,
      contextTokensSource: undefined,
      contextBudgetStatus: undefined,
    });
  });

  it.each<{
    name: string;
    initial: Partial<SessionEntry>;
    next: Partial<SessionEntry>;
    current: Partial<SessionEntry>;
    conflict: boolean;
  }>([
    {
      name: "accepts a model switch after concurrent runtime metadata refresh",
      initial: { contextTokens: 100_000 },
      next: {
        modelOverride: "gpt-5.5",
        modelProvider: undefined,
        model: undefined,
        contextTokens: undefined,
      },
      current: { model: "gpt-5.4-mini", contextTokens: 80_000 },
      conflict: false,
    },
    {
      name: "rejects a model switch after a concurrent thinking override",
      initial: { thinkingLevel: "xhigh" },
      next: { modelOverride: "gpt-5.5", thinkingLevel: "high" },
      current: { thinkingLevel: "low" },
      conflict: true,
    },
  ])("$name", ({ initial: seed, next, current, conflict }) => {
    const before = modelSelection(seed);
    expect(
      sessionSnapshotTouchedFieldsConflict({
        initial: before,
        next: { ...before, ...next },
        current: snapshot(before, 3, current),
        touchedFields: ["providerOverride", "modelOverride", "modelOverrideSource"],
      }),
    ).toBe(conflict);
  });

  it("blocks stale model-dependent state after a concurrent selection", () => {
    const next = snapshot(initial, 2, {
      modelProvider: "openai",
      model: "gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-mini",
      },
      contextTokens: 100_000,
      thinkingLevel: "medium",
    });
    const current = snapshot(initial, 3, {
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });

    expect(mergeSessionSnapshotChanges({ initial, next, current })).toEqual(current);
  });

  it("does not project a stale snapshot across a session rotation", () => {
    const next = { ...initial, thinkingLevel: "high", updatedAt: 2 };
    const current: SessionEntry = {
      sessionId: "session-2",
      updatedAt: 3,
      thinkingLevel: "low",
    };

    expect(mergeSessionSnapshotChanges({ initial, next, current })).toEqual(current);
  });

  it.each<{
    name: string;
    initial: SessionEntry;
    current: Partial<SessionEntry>;
    next?: Partial<SessionEntry>;
    clear?: boolean;
    reassertAbortedLastRun?: boolean;
    expected?: Partial<SessionEntry>;
  }>([
    {
      name: "preserves the aggregate when a restart marker wins a stale healthy clear",
      initial: recovery(
        { revision: 2, chargedAttempts: 0, foregroundClaims: claims("owner-1") },
        { restartRecoveryRuns: [runFence("run-1")] },
      ),
      current: { restartRecoveryRuns: [runFence("run-1"), runFence("run-1", "generation-2")] },
    },
    {
      name: "preserves the safe-tools guard when a newer recovery owner wins a stale clear",
      initial: recovery({}, { restartRecoveryForceSafeTools: true }),
      current: { mainRestartRecovery: recoveryState({ revision: 2 }) },
    },
    {
      name: "preserves recovery when the safe-tools guard is acquired during fence cleanup",
      initial: recovery({ revision: 3 }, { restartRecoveryRuns: interruptedAndRecoveryRuns }),
      current: {
        abortedLastRun: false,
        restartRecoveryRuns: [runFence("interrupted-run")],
        restartRecoveryForceSafeTools: true,
      },
    },
    {
      name: "clears recovery after lifecycle settlement consumes its run fence",
      initial: recovery({ revision: 3 }, { restartRecoveryRuns: interruptedAndRecoveryRuns }),
      current: { abortedLastRun: false, restartRecoveryRuns: [runFence("interrupted-run")] },
      expected: {
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
    },
    {
      name: "preserves every concurrent owner and interruption until lifecycle settlement",
      initial: recovery(),
      current: {
        mainRestartRecovery: recoveryState({
          revision: 3,
          foregroundClaims: claims("owner-1", "owner-2"),
        }),
      },
    },
    {
      name: "reasserts a terminal abort after another owner marks the session healthy",
      initial: recovery({ revision: 3, foregroundClaims: claims("owner-1", "owner-2") }),
      current: {
        abortedLastRun: false,
        mainRestartRecovery: recoveryState({ revision: 4, foregroundClaims: claims("owner-2") }),
      },
      clear: false,
      reassertAbortedLastRun: true,
      expected: { abortedLastRun: true },
    },
    {
      name: "does not attach a stale terminal abort to a replacement recovery cycle",
      initial: recovery({
        cycleId: "cycle-old",
        revision: 2,
        foregroundClaims: { lifecycleGeneration: "generation-old", tokens: ["old-owner"] },
      }),
      current: {
        abortedLastRun: false,
        mainRestartRecovery: recoveryState({
          cycleId: "cycle-new",
          chargedAttempts: 0,
          foregroundClaims: { lifecycleGeneration: "generation-new", tokens: ["new-owner"] },
        }),
      },
      clear: false,
      reassertAbortedLastRun: true,
    },
    {
      name: "preserves a concurrent foreground claim over a partial recovery update",
      initial: recovery({ chargedAttempts: 0 }),
      next: {
        mainRestartRecovery: recoveryState({
          revision: 2,
          reservation: { runId: "recovery-1", attempt: 1, lifecycleGeneration: "generation-1" },
        }),
      },
      current: {
        mainRestartRecovery: recoveryState({
          revision: 2,
          chargedAttempts: 0,
          foregroundClaims: claims("owner-1"),
        }),
      },
      clear: false,
    },
  ])(
    "$name",
    ({ initial: before, next, current, clear = true, expected, reassertAbortedLastRun }) => {
      const latest = snapshot(before, 3, current);
      const proposed = clear
        ? clearedRecovery(before, {
            restartRecoveryRuns: undefined,
            restartRecoveryForceSafeTools: undefined,
            ...next,
          })
        : snapshot(before, 2, next);
      expect(
        mergeSessionSnapshotChanges({
          initial: before,
          next: proposed,
          current: latest,
          reassertAbortedLastRun,
        }),
      ).toEqual({ ...latest, ...expected });
    },
  );
});
