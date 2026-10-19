import { afterEach, beforeEach, expect, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { InternalApplySessionModelSelectionParams } from "./apply-session-model-selection.js";

export function useSelectionEffects(
  mocks: Pick<ReturnType<typeof createModelSelectionMocks>, "effects" | "resetMocks">,
  onSessionLifecycleEvent: typeof import("../sessions/session-lifecycle-events.js").onSessionLifecycleEvent,
  loadProviderScopedThinkingCatalog: typeof import("../agents/model-catalog.runtime.js").loadProviderScopedThinkingCatalog,
) {
  const lifecycleEvents: SessionLifecycleEvent[] = [];
  let unsubscribe: () => void;
  beforeEach(() => {
    mocks.resetMocks();
    vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
    lifecycleEvents.length = 0;
    unsubscribe = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
  });
  afterEach(() => unsubscribe());
  return {
    lifecycleEvents,
    expectNoSelectionEffects() {
      expect(lifecycleEvents).toEqual([]);
      for (const effect of [
        mocks.effects.triggerSessionPatchHook,
        mocks.effects.refreshQueuedFollowupSession,
        mocks.effects.enqueueSystemEvent,
      ]) {
        expect(effect).not.toHaveBeenCalled();
      }
    },
  };
}

export function configuredModels(
  models: ModelCatalogEntry[],
  maxTokens = 4096,
): NonNullable<OpenClawConfig["models"]> {
  return {
    providers: {
      fixture: {
        api: "openai-completions",
        baseUrl: "https://fixture.invalid/v1",
        models: models.map<ModelDefinitionConfig>(({ id, name }) => ({
          id,
          name,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          maxTokens,
        })),
      },
    },
  };
}

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
    prepareRuntimeRefresh: vi.fn(),
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
          getManyAsync: async (sessionIds: readonly string[]) => placementMocks.getMany(sessionIds),
          prepareRuntimeRefresh: placementMocks.prepareRuntimeRefresh,
        },
      }),
    }),
    placementRuntime: () => ({
      resolveWorkerPlacementCapabilities: (...args: unknown[]) =>
        placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities(...args),
    }),
    placementRuntimePreparation: () => ({
      prepareWorkerPlacementSessionRuntime: async () => () => "fixture",
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
    placementMocks.prepareRuntimeRefresh
      .mockReset()
      .mockImplementation(async (sessionId: string) => {
        const placement = placementMocks.getMany([sessionId]).get(sessionId);
        return {
          placement,
          assertCurrent: () => {
            if (placementMocks.getMany([sessionId]).get(sessionId) !== placement) {
              throw new Error("Session placement changed");
            }
          },
          release: () => {},
        };
      });
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

  function createSelectedEntry(
    provider: string,
    model: string,
    overrides: Partial<SessionEntry> = {},
  ) {
    return createEntry({
      providerOverride: provider,
      modelOverride: model,
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      ...overrides,
    });
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

  return { catalog, createEntry, createSelectedEntry, createParams };
}
