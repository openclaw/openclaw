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

const selectedModel: SessionEntry = {
  ...initial,
  providerOverride: "openai",
  modelOverride: "gpt-5.4",
  modelOverrideSource: "user",
};

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
    const next = {
      ...initialOverride,
      updatedAt: 2,
      providerOverride: undefined,
      modelOverride: undefined,
      modelOverrideSource: undefined,
      modelOverrideFallbackOriginProvider: undefined,
      modelOverrideFallbackOriginModel: undefined,
      authProfileOverride: undefined,
      authProfileOverrideSource: undefined,
      fallbackNotice: undefined,
      liveModelSwitchPending: true,
    };
    const current: SessionEntry = {
      ...initialOverride,
      updatedAt: 3,
      modelOverride: "gpt-new",
      modelOverrideSource: "user",
      authProfileOverride: "openai:user",
      authProfileOverrideSource: "user",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-new",
        activeModel: "openai/gpt-fallback",
      },
    };

    expect(mergeSessionSnapshotChanges({ initial: initialOverride, next, current })).toEqual(
      current,
    );
  });

  it.each([false, true])(
    "re-arms a consumed model-switch signal only when requested (%s)",
    (reassert) => {
      const initialOverride: SessionEntry = {
        ...selectedModel,
        liveModelSwitchPending: true,
        ...(reassert ? {} : { thinkingLevel: "high" }),
      };
      const next = { ...initialOverride, updatedAt: 2, modelOverride: "gpt-5.5" };
      const current = {
        ...initialOverride,
        updatedAt: 3,
        ...(reassert ? {} : { thinkingLevel: "low" }),
      };
      delete current.liveModelSwitchPending;
      const merged = mergeSessionSnapshotChanges({
        initial: initialOverride,
        next,
        current,
        ...(reassert ? { reassertLiveModelSwitchPending: true } : {}),
      });
      expect(merged).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
      });
      if (reassert) {
        expect(merged.liveModelSwitchPending).toBe(true);
      } else {
        expect(merged).not.toHaveProperty("liveModelSwitchPending");
        expect(merged.thinkingLevel).toBe("low");
      }
    },
  );

  it("clears stale model-dependent state with the winning model selection", () => {
    const initialOverride: SessionEntry = {
      ...selectedModel,
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
    };
    const next: SessionEntry = {
      ...initialOverride,
      updatedAt: 2,
      modelOverride: "gpt-5.5",
      modelProvider: undefined,
      model: undefined,
      fallbackNotice: undefined,
      contextTokens: undefined,
      contextTokensSource: undefined,
      contextBudgetStatus: undefined,
    };
    const current: SessionEntry = {
      ...initialOverride,
      updatedAt: 3,
      modelProvider: "openai",
      model: "gpt-5.4-mini",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-nano",
      },
      contextTokens: 80_000,
      contextTokensSource: "runtime",
    };

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

  it.each<{
    name: string;
    initialFields: Partial<SessionEntry>;
    nextFields: Partial<SessionEntry>;
    concurrent: Partial<SessionEntry>;
    conflict: boolean;
  }>([
    {
      name: "runtime metadata refresh",
      initialFields: { contextTokens: 100_000 },
      nextFields: { modelProvider: undefined, model: undefined, contextTokens: undefined },
      concurrent: { model: "gpt-5.4-mini", contextTokens: 80_000 },
      conflict: false,
    },
    {
      name: "thinking override",
      initialFields: { thinkingLevel: "xhigh" },
      nextFields: { thinkingLevel: "high" },
      concurrent: { thinkingLevel: "low" },
      conflict: true,
    },
  ])(
    "checks model-selection conflicts after concurrent $name",
    ({ initialFields, nextFields, concurrent, conflict }) => {
      const initialOverride = { ...selectedModel, ...initialFields };
      expect(
        sessionSnapshotTouchedFieldsConflict({
          initial: initialOverride,
          next: { ...initialOverride, modelOverride: "gpt-5.5", ...nextFields },
          current: { ...initialOverride, updatedAt: 3, ...concurrent },
          touchedFields: ["providerOverride", "modelOverride", "modelOverrideSource"],
        }),
      ).toBe(conflict);
    },
  );

  it("blocks stale model-dependent state after a concurrent selection", () => {
    const next: SessionEntry = {
      ...initial,
      updatedAt: 2,
      modelProvider: "openai",
      model: "gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-mini",
      },
      contextTokens: 100_000,
      thinkingLevel: "medium",
    };
    const current: SessionEntry = {
      ...initial,
      updatedAt: 3,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    };

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

  type Recovery = NonNullable<SessionEntry["mainRestartRecovery"]>;
  const recovery = (
    revision: number,
    chargedAttempts: number,
    extra: Partial<Recovery> = {},
  ): Recovery => ({
    cycleId: "cycle-1",
    revision,
    chargedAttempts,
    ...extra,
  });
  const claims = (tokens: string[], lifecycleGeneration = "generation-1") => ({
    lifecycleGeneration,
    tokens,
  });
  const run = (runId: string, lifecycleGeneration = "generation-1") => ({
    runId,
    lifecycleGeneration,
  });

  it.each<{
    name: string;
    before: Partial<SessionEntry>;
    next: Partial<SessionEntry>;
    concurrent: Partial<SessionEntry>;
  }>([
    {
      name: "a restart marker wins a stale healthy clear",
      before: {
        restartRecoveryRuns: [run("run-1")],
        mainRestartRecovery: recovery(2, 0, { foregroundClaims: claims(["owner-1"]) }),
      },
      next: {
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
      concurrent: { restartRecoveryRuns: [run("run-1"), run("run-1", "generation-2")] },
    },
    {
      name: "a newer recovery owner wins a stale safe-tools clear",
      before: { restartRecoveryForceSafeTools: true, mainRestartRecovery: recovery(1, 1) },
      next: {
        abortedLastRun: false,
        restartRecoveryForceSafeTools: undefined,
        mainRestartRecovery: undefined,
      },
      concurrent: { mainRestartRecovery: recovery(2, 1) },
    },
    {
      name: "concurrent foreground owners remain unsettled",
      before: { mainRestartRecovery: recovery(1, 1) },
      next: { abortedLastRun: false, mainRestartRecovery: undefined },
      concurrent: {
        mainRestartRecovery: recovery(3, 1, { foregroundClaims: claims(["owner-1", "owner-2"]) }),
      },
    },
    {
      name: "a foreground claim overtakes a partial recovery update",
      before: { mainRestartRecovery: recovery(1, 0) },
      next: {
        mainRestartRecovery: recovery(2, 1, {
          reservation: { runId: "recovery-1", attempt: 1, lifecycleGeneration: "generation-1" },
        }),
      },
      concurrent: {
        mainRestartRecovery: recovery(2, 0, { foregroundClaims: claims(["owner-1"]) }),
      },
    },
  ])("preserves the concurrent recovery aggregate when $name", ({ before, next, concurrent }) => {
    const initialRecovery: SessionEntry = { ...initial, abortedLastRun: true, ...before };
    const current = { ...initialRecovery, updatedAt: 3, ...concurrent };
    const expected = structuredClone(current);
    const merged = mergeSessionSnapshotChanges({
      initial: initialRecovery,
      next: { ...initialRecovery, updatedAt: 2, ...next },
      current,
    });
    expect(merged).toEqual(expected);
  });

  it.each([false, true])(
    "clears consumed lifecycle fences only without an acquired safe-tools guard (%s)",
    (acquiredGuard) => {
      const initialRecovery: SessionEntry = {
        ...initial,
        abortedLastRun: true,
        restartRecoveryRuns: [run("interrupted-run"), run("recovery-run")],
        mainRestartRecovery: recovery(3, 1),
      };
      const next = {
        ...initialRecovery,
        updatedAt: 2,
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
        ...(acquiredGuard ? { restartRecoveryForceSafeTools: undefined } : {}),
      };
      const current: SessionEntry = {
        ...structuredClone(initialRecovery),
        updatedAt: 3,
        abortedLastRun: false,
        restartRecoveryRuns: [run("interrupted-run")],
        ...(acquiredGuard ? { restartRecoveryForceSafeTools: true } : {}),
      };
      const expected = structuredClone(current);
      const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });
      if (acquiredGuard) {
        expect(merged).toEqual(expected);
      } else {
        expect(merged.abortedLastRun).toBe(false);
        for (const field of ["restartRecoveryRuns", "mainRestartRecovery"] as const) {
          expect(merged).not.toHaveProperty(field);
        }
      }
    },
  );

  it.each([false, true])(
    "reasserts terminal abort only within its original recovery cycle (replaced: %s)",
    (replaced) => {
      const initialRecovery: SessionEntry = {
        ...initial,
        abortedLastRun: true,
        mainRestartRecovery: replaced
          ? recovery(2, 1, {
              cycleId: "cycle-old",
              foregroundClaims: claims(["old-owner"], "generation-old"),
            })
          : recovery(3, 1, { foregroundClaims: claims(["owner-1", "owner-2"]) }),
      };
      const current: SessionEntry = {
        ...structuredClone(initialRecovery),
        updatedAt: 3,
        abortedLastRun: false,
        mainRestartRecovery: replaced
          ? recovery(1, 0, {
              cycleId: "cycle-new",
              foregroundClaims: claims(["new-owner"], "generation-new"),
            })
          : recovery(4, 1, { foregroundClaims: claims(["owner-2"]) }),
      };
      const merged = mergeSessionSnapshotChanges({
        initial: initialRecovery,
        next: { ...structuredClone(initialRecovery), updatedAt: 2 },
        current,
        reassertAbortedLastRun: true,
      });
      expect(merged.abortedLastRun).toBe(!replaced);
      expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
    },
  );
});
