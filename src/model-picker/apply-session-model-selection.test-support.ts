import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import type { InternalApplySessionModelSelectionParams } from "./apply-session-model-selection.js";

const mocks = vi.hoisted(() => {
  const validateRuntime = vi.fn<() => string | undefined>(() => undefined);
  const prepareRuntime = vi.fn<
    typeof import("../agents/model-runtime-choice.js").preparePublishedModelRuntimeChoice
  >(async ({ runtimeId, preferredRuntimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? preferredRuntimeId ?? "openclaw",
    validate: validateRuntime,
  }));
  const effects = {
    enqueueSystemEvent: vi.fn(),
    mutateConfigFileWithRetry: vi.fn(),
    refreshQueuedFollowupSession: vi.fn(),
    triggerSessionPatchHook: vi.fn(),
  };
  const placementMocks = {
    getMany: vi.fn(),
    prepareRuntimeRefresh: vi.fn(),
    resolveWorkerPlacementSessionRuntimeCapabilities: vi.fn(),
  };
  const resetMocks = () => {
    validateRuntime.mockReset().mockReturnValue(undefined);
    for (const mock of [...Object.values(effects), ...Object.values(placementMocks)]) {
      mock.mockReset();
    }
    effects.mutateConfigFileWithRetry.mockResolvedValue({ nextConfig: {}, result: "defaults" });
    placementMocks.getMany.mockReturnValue(new Map());
    placementMocks.prepareRuntimeRefresh.mockImplementation(async (sessionId: string) => {
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
  };
  return { effects, placementMocks, resetMocks, prepareRuntime, validateRuntime };
});
export { mocks as selectionMocks };

// mock-isolation: Runtime eligibility belongs to its owner; these tests exercise selection effects.
vi.mock("../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: mocks.prepareRuntime,
}));
// mock-isolation: Supply a deterministic thinking catalog without provider discovery.
vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));
// mock-isolation: Capture system-event effects without publishing into the process event store.
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.effects.enqueueSystemEvent,
}));
// mock-isolation: Observe queue refresh effects without dispatching queued follow-up work.
vi.mock("../auto-reply/reply/queue.js", () => ({
  refreshQueuedFollowupSession: mocks.effects.refreshQueuedFollowupSession,
}));
// mock-isolation: Observe patch hooks without invoking installed plugins.
vi.mock("../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: mocks.effects.triggerSessionPatchHook,
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  mutateConfigFileWithRetry: mocks.effects.mutateConfigFileWithRetry,
}));
// mock-isolation: Placement state is a controlled fixture rather than the live worker registry.
vi.mock("../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      prepareRuntimeRefresh: mocks.placementMocks.prepareRuntimeRefresh,
    },
  }),
}));
// mock-isolation: Runtime eligibility and worker preparation are tested by their owners.
vi.mock("../gateway/worker-environments/placement-session-runtime.js", () => ({
  resolveWorkerPlacementCapabilities:
    mocks.placementMocks.resolveWorkerPlacementSessionRuntimeCapabilities,
}));
// mock-isolation: Worker preparation is owned elsewhere; selection receives a synthetic lease.
vi.mock("../gateway/worker-environments/placement-session-runtime-preparation.js", () => ({
  prepareWorkerPlacementSessionRuntime: async () => () => "fixture",
}));

export function useSelectionEffects() {
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
    expectNoSelectionEffects: () => {
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

export function useSelectionStore(prefix: string) {
  const dirs = useSessionStoreTempDirs(afterAll, prefix);
  return async (sessionEntry: SessionEntry, sessionKey: string) => {
    const storePath = path.join(dirs.make(), "sessions.json");
    await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
    return { sessionEntry, sessionKey, storePath };
  };
}

export function createModelSelectionInputs() {
  const catalog = [
    { provider: "anthropic", id: "claude-opus-4-6", name: "Opus", contextTokens: 32_000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextTokens: 16_000 },
  ] satisfies ModelCatalogEntry[];

  function createEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return { sessionId: "session-1", updatedAt: 1, delivery: { kind: "none" }, ...overrides };
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
      request: createRequest("openai", "gpt-4o"),
      markLiveSwitchPending: true,
      ...overrides,
    } satisfies InternalApplySessionModelSelectionParams;
  }

  function createFixtureParams(
    modelCatalog: ModelCatalogEntry[],
    defaults: AgentDefaultsConfig,
    overrides: Partial<InternalApplySessionModelSelectionParams> = {},
    maxTokens = 4096,
  ) {
    const fixture: ModelProviderConfig = {
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      models: modelCatalog.map(({ id, name }) => ({
        id,
        name,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens,
      })),
    };
    return createParams({
      cfg: { agents: { defaults }, models: { providers: { fixture } } },
      defaultProvider: "fixture",
      defaultModel: "primary",
      currentProvider: "fixture",
      currentModel: "manual",
      sessionEntry: createEntry({ providerOverride: "fixture", modelOverride: "manual" }),
      modelCatalog,
      thinkingCatalog: modelCatalog,
      request: createRequest("fixture", "manual"),
      ...overrides,
    });
  }

  return { catalog, createEntry, createSelectedEntry, createParams, createFixtureParams };
}

export function createRequest(
  provider: string,
  model: string,
  overrides: Partial<InternalApplySessionModelSelectionParams["request"]> = {},
): InternalApplySessionModelSelectionParams["request"] {
  return { provider, model, isDefault: false, runtime: { kind: "unchanged" }, ...overrides };
}
