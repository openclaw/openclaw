import { vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { InternalApplySessionModelSelectionParams } from "./apply-session-model-selection.js";

export function createModelSelectionMocks() {
  const effects = {
    enqueueSystemEvent: vi.fn(),
    info: vi.fn(),
    mutateConfigFileWithRetry: vi.fn(),
    refreshQueuedFollowupSession: vi.fn(),
    triggerSessionPatchHook: vi.fn(),
    warn: vi.fn(),
  };
  const placementMocks = {
    getMany: vi.fn(),
    resolveWorkerPlacementSessionRuntimeCapabilities: vi.fn(),
  };
  const factories = {
    systemEvents: () => ({
      enqueueSystemEvent: (...args: unknown[]) => effects.enqueueSystemEvent(...args),
    }),
    queue: () => ({
      refreshQueuedFollowupSession: (...args: unknown[]) =>
        effects.refreshQueuedFollowupSession(...args),
    }),
    patchHooks: () => ({
      triggerSessionPatchHook: (...args: unknown[]) => effects.triggerSessionPatchHook(...args),
    }),
    config: async () => {
      const actual =
        await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
      return { ...actual, mutateConfigFileWithRetry: effects.mutateConfigFileWithRetry };
    },
    logging: async () => {
      const actual =
        await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
      return {
        ...actual,
        createSubsystemLogger: (subsystem: string) =>
          subsystem === "agents/sticky-model-selection"
            ? { info: effects.info, warn: effects.warn }
            : actual.createSubsystemLogger(subsystem),
      };
    },
    placementContext: () => ({
      resolveSessionWorkerPlacementContext: () => ({
        workerSessionPlacementService: {
          getMany: placementMocks.getMany,
        },
      }),
    }),
    placementRuntime: () => ({
      resolveWorkerPlacementSessionRuntimeCapabilities:
        placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities,
    }),
  };
  const resetMocks = () => {
    effects.enqueueSystemEvent.mockReset();
    effects.info.mockReset();
    effects.warn.mockReset();
    effects.mutateConfigFileWithRetry.mockReset().mockResolvedValue({
      nextConfig: {},
      result: "defaults",
    });
    effects.refreshQueuedFollowupSession.mockReset();
    effects.triggerSessionPatchHook.mockReset();
    placementMocks.getMany.mockReset().mockReturnValue(new Map());
    placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities.mockReset();
  };
  return { effects, placementMocks, factories, resetMocks };
}

export function createModelSelectionInputs() {
  const catalog = [
    {
      provider: "anthropic",
      id: "claude-opus-4-6",
      name: "Claude Opus",
      contextTokens: 32_000,
    },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextTokens: 16_000 },
  ] satisfies ModelCatalogEntry[];

  function createEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      sessionId: "session-1",
      updatedAt: 1,
      delivery: { kind: "none" },
      ...overrides,
    };
  }

  function createParams(overrides: Partial<InternalApplySessionModelSelectionParams> = {}) {
    const sessionEntry = overrides.sessionEntry ?? createEntry();
    const sessionKey = overrides.sessionKey ?? "agent:main:dm:1";
    return {
      cfg: {},
      agentId: "main",
      sessionKey,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      currentProvider: "anthropic",
      currentModel: "claude-opus-4-6",
      modelCatalog: catalog,
      thinkingCatalog: catalog,
      canPersistStickyModelSelection: false,
      request: {
        provider: "openai",
        model: "gpt-4o",
        isDefault: false,
        runtime: { kind: "unchanged" },
      },
      markLiveSwitchPending: true,
      ...overrides,
    } satisfies InternalApplySessionModelSelectionParams;
  }

  return { catalog, createEntry, createParams };
}
