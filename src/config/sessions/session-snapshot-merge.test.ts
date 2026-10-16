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
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 1, ...state },
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
      const existing: SessionEntry = {
        ...initial,
        sandbox: "required",
      };
      const patch: Partial<SessionEntry> = {};
      Object.assign(patch, { sandbox });

      expect(mergeSessionEntry(existing, patch)).toMatchObject({ sandbox: "required" });
    },
  );

  it("does not add a creation sandbox to an existing unstamped session", () => {
    expect(mergeSessionEntry(initial, { sandbox: "required" })).not.toHaveProperty("sandbox");
  });

  it.each([undefined] as const)(
    "retains creation surface %s through merge and transcript rollover",
    (createdSurface) => {
      const existing = { ...initial, createdSurface };
      for (const surface of [undefined, "plugin-dock"] as const) {
        expect(
          mergeSessionEntry(existing, { sessionId: "new-transcript", createdSurface: surface })
            .createdSurface,
        ).toBe(createdSurface);
      }
    },
  );

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

    expect(merged).toMatchObject({
      modelOverride: "gpt-5.5",
      thinkingLevel: "low",
    });
    expect(merged.liveModelSwitchPending).toBeUndefined();
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

    expect(merged).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });
    expect(merged.modelProvider).toBeUndefined();
    expect(merged.model).toBeUndefined();
    expect(merged.fallbackNotice).toBeUndefined();
    expect(merged.contextTokens).toBeUndefined();
    expect(merged.contextTokensSource).toBeUndefined();
    expect(merged.contextBudgetStatus).toBeUndefined();
  });

  it("does not reject a model switch after concurrent runtime metadata refresh", () => {
    const initialOverride = modelSelection({
      contextTokens: 100_000,
    });
    const next: SessionEntry = {
      ...initialOverride,
      modelOverride: "gpt-5.5",
      modelProvider: undefined,
      model: undefined,
      contextTokens: undefined,
    };
    const current = snapshot(initialOverride, 3, {
      model: "gpt-5.4-mini",
      contextTokens: 80_000,
    });

    expect(
      sessionSnapshotTouchedFieldsConflict({
        initial: initialOverride,
        next,
        current,
        touchedFields: ["providerOverride", "modelOverride", "modelOverrideSource"],
      }),
    ).toBe(false);
  });

  it("rejects a model switch after a concurrent thinking override", () => {
    const initialOverride = modelSelection({
      thinkingLevel: "xhigh",
    });
    const next: SessionEntry = {
      ...initialOverride,
      modelOverride: "gpt-5.5",
      thinkingLevel: "high",
    };
    const current = snapshot(initialOverride, 3, {
      thinkingLevel: "low",
    });

    expect(
      sessionSnapshotTouchedFieldsConflict({
        initial: initialOverride,
        next,
        current,
        touchedFields: ["providerOverride", "modelOverride", "modelOverrideSource"],
      }),
    ).toBe(true);
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

  it("preserves the recovery aggregate when a restart marker wins a stale healthy clear", () => {
    const initialRecovery = recovery(
      {
        revision: 2,
        chargedAttempts: 0,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1"],
        },
      },
      {
        restartRecoveryRuns: [{ runId: "run-1", lifecycleGeneration: "generation-1" }],
      },
    );
    const next = clearedRecovery(initialRecovery, {
      restartRecoveryRuns: undefined,
    });
    const current = snapshot(initialRecovery, 3, {
      restartRecoveryRuns: [
        ...(initialRecovery.restartRecoveryRuns ?? []),
        { runId: "run-1", lifecycleGeneration: "generation-2" },
      ],
    });

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.abortedLastRun).toBe(true);
    expect(merged.restartRecoveryRuns).toEqual(current.restartRecoveryRuns);
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("preserves the safe-tools guard when a newer recovery owner wins a stale clear", () => {
    const initialRecovery = recovery(
      {},
      {
        restartRecoveryForceSafeTools: true,
      },
    );
    const next = clearedRecovery(initialRecovery, {
      restartRecoveryForceSafeTools: undefined,
    });
    const current = snapshot(initialRecovery, 3, {
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 2,
      },
    });

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.restartRecoveryForceSafeTools).toBe(true);
    expect(merged.abortedLastRun).toBe(true);
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("preserves recovery state when the safe-tools guard is acquired during fence cleanup", () => {
    const initialRecovery = recovery(
      {
        revision: 3,
      },
      {
        restartRecoveryRuns: interruptedAndRecoveryRuns,
      },
    );
    const next = clearedRecovery(initialRecovery, {
      restartRecoveryRuns: undefined,
      restartRecoveryForceSafeTools: undefined,
    });
    const current = snapshot(structuredClone(initialRecovery), 3, {
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "generation-1" }],
      restartRecoveryForceSafeTools: true,
    });

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.restartRecoveryForceSafeTools).toBe(true);
    expect(merged.restartRecoveryRuns).toEqual(current.restartRecoveryRuns);
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("clears recovery after lifecycle settlement consumes its run fence", () => {
    const initialRecovery = recovery(
      {
        revision: 3,
      },
      {
        restartRecoveryRuns: interruptedAndRecoveryRuns,
      },
    );
    const next = clearedRecovery(initialRecovery, {
      restartRecoveryRuns: undefined,
    });
    const current = snapshot(structuredClone(initialRecovery), 3, {
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "generation-1" }],
    });

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.abortedLastRun).toBe(false);
    expect(merged.restartRecoveryRuns).toBeUndefined();
    expect(merged.mainRestartRecovery).toBeUndefined();
  });

  it("preserves every concurrent owner and interruption until lifecycle settlement", () => {
    const initialRecovery = recovery({});
    const next = clearedRecovery(initialRecovery);
    const current = snapshot(initialRecovery, 3, {
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 3,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1", "owner-2"],
        },
      },
    });

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.abortedLastRun).toBe(true);
    expect(merged.restartRecoveryRuns).toBeUndefined();
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
    expect(merged.mainRestartRecovery?.foregroundClaims?.tokens).toEqual(["owner-1", "owner-2"]);
  });

  it("reasserts a terminal abort after another owner marks the session healthy", () => {
    const initialRecovery = recovery({
      revision: 3,
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["owner-1", "owner-2"],
      },
    });
    const next = snapshot(structuredClone(initialRecovery), 2);
    const current = snapshot(structuredClone(initialRecovery), 3, {
      abortedLastRun: false,
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 4,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-2"],
        },
      },
    });

    const merged = mergeSessionSnapshotChanges({
      initial: initialRecovery,
      next,
      current,
      reassertAbortedLastRun: true,
    });

    expect(merged.abortedLastRun).toBe(true);
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("does not attach a stale terminal abort to a replacement recovery cycle", () => {
    const initialRecovery = recovery({
      cycleId: "cycle-old",
      revision: 2,
      foregroundClaims: {
        lifecycleGeneration: "generation-old",
        tokens: ["old-owner"],
      },
    });
    const current = snapshot(structuredClone(initialRecovery), 3, {
      abortedLastRun: false,
      mainRestartRecovery: {
        cycleId: "cycle-new",
        revision: 1,
        chargedAttempts: 0,
        foregroundClaims: {
          lifecycleGeneration: "generation-new",
          tokens: ["new-owner"],
        },
      },
    });

    const merged = mergeSessionSnapshotChanges({
      initial: initialRecovery,
      next: { ...structuredClone(initialRecovery), updatedAt: 2 },
      current,
      reassertAbortedLastRun: true,
    });

    expect(merged.abortedLastRun).toBe(false);
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("preserves a concurrent foreground claim over a partial recovery update", () => {
    const initialRecovery = recovery({
      chargedAttempts: 0,
    });
    const next = snapshot(initialRecovery, 2, {
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 2,
        chargedAttempts: 1,
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          lifecycleGeneration: "generation-1",
        },
      },
    });
    const current = snapshot(initialRecovery, 3, {
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 2,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1"],
        },
      },
    });

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
    expect(merged.mainRestartRecovery?.reservation).toBeUndefined();
  });
});
