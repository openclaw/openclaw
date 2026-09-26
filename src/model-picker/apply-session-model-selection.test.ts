import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionsPatchEntry } from "../gateway/sessions-patch.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { createModelSelectionInputs } from "./apply-session-model-selection.test-support.js";

// Runtime eligibility belongs to the published-owner tests; these cases exercise its consumers.
vi.mock("../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn<
    typeof import("../agents/model-runtime-choice.js").preparePublishedModelRuntimeChoice
  >(async ({ runtimeId, preferredRuntimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? preferredRuntimeId ?? "openclaw",
    validate: () => undefined,
  })),
}));

vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

const { effects, factories, resetMocks } = await vi.hoisted(async () => {
  const { createModelSelectionMocks } =
    await import("./apply-session-model-selection.test-support.js");
  return createModelSelectionMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let lifecycleEvents: SessionLifecycleEvent[];
let unsubscribeLifecycle: () => void;

vi.mock("../infra/system-events.js", factories.systemEvents);
vi.mock("../auto-reply/reply/queue.js", factories.queue);
vi.mock("../gateway/session-patch-hooks.js", factories.patchHooks);
vi.mock("../config/config.js", factories.config);

vi.mock("../logging/subsystem.js", factories.logging);

vi.mock("../gateway/session-worker-placement-context.js", factories.placementContext);
vi.mock("../gateway/worker-environments/placement-session-runtime.js", factories.placementRuntime);

import {
  applySessionModelSelectionInternal as applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "./apply-session-model-selection.js";

const { catalog, createEntry, createParams } = createModelSelectionInputs();

function expectNoSelectionEffects() {
  expect(lifecycleEvents).toEqual([]);
  expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
  expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
  expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
}

function createRequest(
  provider: string,
  model: string,
  overrides: Partial<ApplySessionModelSelectionParams["request"]> = {},
): ApplySessionModelSelectionParams["request"] {
  return { provider, model, isDefault: false, runtime: { kind: "unchanged" }, ...overrides };
}

beforeEach(() => {
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
  lifecycleEvents = [];
  unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
  resetMocks();
});

afterEach(() => unsubscribeLifecycle());

describe("applySessionModelSelection", () => {
  it.each([false, true])("uses configured default only with reset intent=%s", async (reset) => {
    const modelCatalog = [
      { provider: "fixture", id: "automatic", name: "Automatic" },
      { provider: "fixture", id: "manual", name: "Manual" },
    ];
    const sessionEntry = createEntry({ providerOverride: "fixture", modelOverride: "manual" });
    const result = await applySessionModelSelection(
      createParams({
        cfg: {
          agents: {
            defaults: {
              model: "fixture/automatic",
              modelPolicy: { allow: ["fixture/manual"] },
            },
          },
          models: {
            providers: {
              fixture: {
                api: "openai-completions",
                baseUrl: "https://fixture.invalid/v1",
                models: modelCatalog.map<ModelDefinitionConfig>(({ id, name }) => ({
                  id,
                  name,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 4_096,
                })),
              },
            },
          },
        },
        sessionEntry,
        defaultProvider: "fixture",
        defaultModel: "stale-default-hint",
        currentProvider: "fixture",
        currentModel: "manual",
        modelCatalog,
        thinkingCatalog: modelCatalog,
        request: createRequest("fixture", reset ? "manual" : "automatic", {
          isDefault: true,
          ...(reset ? { resetToDefault: true as const } : {}),
        }),
      }),
    );
    expect(result).toMatchObject(
      reset
        ? { status: "applied", provider: "fixture", model: "automatic" }
        : { status: "rejected", reason: "not-allowed" },
    );
    expect(sessionEntry.modelOverride).toBe(reset ? undefined : "manual");
  });

  it.each<{
    name: string;
    overrides: Partial<ApplySessionModelSelectionParams>;
    reason: string;
    message?: string;
  }>([
    {
      name: "unknown provider",
      overrides: {
        request: createRequest("missing-provider", "reasoner"),
      },
      reason: "unknown-provider",
    },
    {
      name: "unknown runtime",
      overrides: {
        request: createRequest("openai", "gpt-5.6-luna", {
          runtime: { kind: "set", runtime: "missing-runtime" },
        }),
      },
      reason: "invalid-runtime",
    },
    {
      name: "incompatible runtime",
      overrides: {
        request: createRequest("anthropic", "claude-opus-4-6", {
          isDefault: true,
          runtime: { kind: "set", runtime: "codex" },
        }),
      },
      reason: "invalid-runtime",
      message: 'Runtime "codex" is not supported for anthropic.',
    },
    {
      name: "model outside allowlist",
      overrides: { cfg: { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } } },
      reason: "not-allowed",
      message: "Model openai/gpt-4o is not available for this agent.",
    },
  ])("rejects $name without mutation or effects", async ({ overrides, reason, message }) => {
    const params = createParams({
      sessionEntry: createEntry({ thinkingLevel: "high" }),
      modelCatalog: [catalog[0]!],
      thinkingCatalog: [catalog[0]!],
      ...overrides,
    });
    const initial = structuredClone(params.sessionEntry);
    const result = await applySessionModelSelection(params);
    expect(result).toMatchObject({ status: "rejected", reason, ...(message ? { message } : {}) });
    expect(params.sessionEntry).toEqual(initial);
    expectNoSelectionEffects();
    expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  });

  it.each([undefined, { allow: ["openai/*"] }])(
    "persists an off-catalog selection under policy %j without credentials",
    async (modelPolicy) => {
      const sessionEntry = createEntry({ thinkingLevel: "high" });
      const cfg: OpenClawConfig = { agents: { defaults: { modelPolicy } } };
      const result = await applySessionModelSelection(
        createParams({
          cfg,
          sessionEntry,
          modelCatalog: [catalog[0]!],
          thinkingCatalog: [catalog[0]!],
          request: createRequest("openai", "gpt-5.6-luna"),
        }),
      );
      expect(result).toMatchObject({
        status: "applied",
        provider: "openai",
        model: "gpt-5.6-luna",
      });
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-luna",
        modelOverrideSource: "user",
        thinkingLevel: "high",
      });
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("publishes a profile-only selection after the scoped session has persisted", async () => {
    const tempRoot = tempDirs.make("openclaw-model-picker-profile-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:profile";
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "auto",
    });
    await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
    let publishedEntry: SessionEntry | undefined;
    const unsubscribe = onSessionLifecycleEvent(() => {
      publishedEntry = loadSessionEntryReadOnly({ sessionKey, storePath });
    });
    try {
      const result = await applySessionModelSelection(
        createParams({
          sessionEntry,
          sessionKey,
          storePath,
          currentProvider: "openai",
          currentModel: "gpt-5.6-luna",
          modelCatalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
          request: createRequest("openai", "gpt-5.6-luna", {
            profileOverride: "openai:work",
          }),
        }),
      );

      expect(result).toMatchObject({ status: "applied", changed: true });
      expect(lifecycleEvents).toEqual([
        { sessionKey, agentId: "main", reason: "patch", catalogChanged: true },
      ]);
      expect(publishedEntry).toMatchObject({
        sessionId: "session-1",
        modelOverride: "gpt-5.6-luna",
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user",
      });
      expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("applies authorized selection effects once to the resolved target session", async () => {
    const sessionKey = "agent:main:telegram:bound:thread:42";
    const sessionEntry = createEntry({
      model: "claude-opus-4-6",
      modelProvider: "anthropic",
      contextTokens: 8_000,
      contextBudgetStatus: {} as NonNullable<SessionEntry["contextBudgetStatus"]>,
    });
    const result = await applySessionModelSelection(
      createParams({
        sessionEntry,
        sessionKey,
        canPersistStickyModelSelection: true,
        request: createRequest("openai", "gpt-4o", {
          isDefault: true,
          alias: "Fast",
          profileOverride: "openai:work",
        }),
      }),
    );

    expect(result).toMatchObject({
      status: "applied",
      provider: "openai",
      model: "gpt-4o",
      effectiveModelRef: "openai/gpt-4o",
      changed: true,
      contextTokens: 16_000,
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    expect(sessionEntry.model).toBeUndefined();
    expect(sessionEntry.modelProvider).toBeUndefined();
    expect(sessionEntry.contextTokens).toBeUndefined();
    expect(sessionEntry.contextBudgetStatus).toBeUndefined();
    expect(effects.triggerSessionPatchHook).toHaveBeenCalledOnce();
    expect(effects.triggerSessionPatchHook).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, patch: { key: sessionKey, model: "openai/gpt-4o" } }),
    );
    expect(result).toMatchObject({ configuredDefaultUpdate: "requested" });
    await vi.waitFor(() => expect(effects.mutateConfigFileWithRetry).toHaveBeenCalledOnce());
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({ key: sessionKey }),
    );
    expect(effects.enqueueSystemEvent).toHaveBeenCalledWith(
      "Model switched to Fast (openai/gpt-4o).",
      { sessionKey, contextKey: "model:openai/gpt-4o" },
    );
  });

  it.each([
    {
      provider: "anthropic",
      model: "claude-opus-4-6",
      currentModel: "gpt-4o",
      canPersistStickyModelSelection: false,
      runtime: { agentHarnessId: "codex", agentRuntimeOverride: "codex" },
    },
    {
      provider: "openai",
      model: "gpt-4o",
      currentModel: "gpt-4.1",
      canPersistStickyModelSelection: true,
      runtime: {},
    },
  ])(
    "resets to a $provider default and preserves only compatible auth",
    async ({ provider, model, currentModel, canPersistStickyModelSelection, runtime }) => {
      const compatible = provider === "openai";
      const sessionEntry = createEntry({
        providerOverride: "openai",
        modelOverride: currentModel,
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
        ...runtime,
      });
      const result = await applySessionModelSelection(
        createParams({
          sessionEntry,
          defaultProvider: provider,
          defaultModel: model,
          currentProvider: "openai",
          currentModel,
          canPersistStickyModelSelection,
          request: createRequest(provider, model, {
            runtime: compatible ? { kind: "unchanged" } : { kind: "clear" },
          }),
        }),
      );

      expect(result).toMatchObject({ status: "applied", changed: true });
      expect(result).not.toHaveProperty("configuredDefaultUpdate");
      if (!compatible) {
        expect(result).toMatchObject({ runtimeChange: { kind: "clear" } });
        expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
        expect(sessionEntry.agentHarnessId).toBe("codex");
      }
      expect(sessionEntry.providerOverride).toBeUndefined();
      expect(sessionEntry.modelOverride).toBeUndefined();
      expect(sessionEntry.modelOverrideSource).toBe("default");
      expect(sessionEntry.modelOverrideRouteResolution).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBe(compatible ? "openai:work" : undefined);
      expect(sessionEntry.authProfileOverrideSource).toBe(compatible ? "user" : undefined);
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(compatible ? 3 : undefined);
      expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({ nextModelOverrideSource: undefined }),
      );
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("resolves SDK effective persistence from the current write draft", async () => {
    const cfg = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
    const draft = {
      agents: {
        ...cfg.agents,
        entries: { main: { model: "anthropic/claude-sonnet-4-6" } },
      },
    };
    effects.mutateConfigFileWithRetry.mockImplementationOnce(
      async ({ mutate }: { mutate: (config: OpenClawConfig) => string }) => ({
        nextConfig: draft,
        result: mutate(draft),
      }),
    );

    await applySessionModelSelection(createParams({ cfg, canPersistStickyModelSelection: true }));

    await vi.waitFor(() => expect(effects.info).toHaveBeenCalledOnce());
    expect(draft.agents.defaults.model).toBe("anthropic/claude-opus-4-6");
    expect(draft.agents.entries.main.model).toBe("openai/gpt-4o");
  });

  it.each([undefined, "codex"])(
    "clears inherited but rejects explicit Gateway runtime %s",
    async (agentRuntime) => {
      const sessionEntry = createEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4o",
        agentRuntimeOverride: "codex",
        nativeRuntimeConsent: "codex",
      });
      const { cfg, sessionKey } = createParams({ sessionEntry });
      const initial = structuredClone(sessionEntry);
      const result = await projectSessionsPatchEntry({
        cfg,
        storeKey: sessionKey,
        existingEntry: sessionEntry,
        isLabelInUse: () => false,
        patch: {
          key: sessionKey,
          model: "anthropic/claude-opus-4-6",
          ...(agentRuntime ? { agentRuntime } : {}),
        },
        loadGatewayModelCatalogSnapshot: async () => ({ entries: catalog, routeVariants: catalog }),
      });
      if (agentRuntime) {
        expect(result).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining('Runtime "codex" is not supported') },
        });
      } else {
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("Model switch failed");
        }
        expect(result.entry.agentRuntimeOverride).toBeUndefined();
        expect(result.entry.nativeRuntimeConsent).toBeUndefined();
        expect(result.entry).toMatchObject({
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
        });
      }
      expect(sessionEntry).toEqual(initial);
    },
  );

  it.each([undefined, "openclaw", "claude-cli"])(
    "persists SDK model-only selection with inherited runtime %s",
    async (agentRuntimeOverride) => {
      const tempRoot = tempDirs.make("openclaw-model-picker-runtime-");
      const storePath = path.join(tempRoot, "sessions.json");
      const sessionKey = "agent:main:dm:runtime-compat";
      const sessionEntry = createEntry({
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        ...(agentRuntimeOverride
          ? { agentRuntimeOverride, nativeRuntimeConsent: agentRuntimeOverride }
          : {}),
      });
      await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
      const result = await applySessionModelSelection(
        createParams({
          cfg: {
            agents: {
              defaults: { models: { "openai/gpt-4o": { agentRuntime: { id: "openclaw" } } } },
            },
          },
          sessionEntry,
          sessionKey,
          storePath,
        }),
      );
      expect(result).toMatchObject({
        status: "applied",
        provider: "openai",
        model: "gpt-4o",
        agentRuntime: "openclaw",
      });
      const stored = loadSessionEntryReadOnly({ sessionKey, storePath });
      expect(stored).toMatchObject({ providerOverride: "openai", modelOverride: "gpt-4o" });
      const compatible = agentRuntimeOverride === "openclaw";
      expect(stored?.agentRuntimeOverride).toBe(compatible ? "openclaw" : undefined);
      expect(stored?.nativeRuntimeConsent).toBe(compatible ? "openclaw" : undefined);
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale in-memory snapshot when the session store row is locked", async () => {
    const sessionEntry = createEntry();
    const lockedEntry = createEntry({ modelSelectionLocked: true, updatedAt: 2 });
    const sessionKey = "agent:main:dm:locked-store";
    const result = await applySessionModelSelection(
      createParams({
        sessionEntry,
        sessionKey,
        sessionStore: { [sessionKey]: lockedEntry },
      }),
    );

    expect(result).toMatchObject({ status: "rejected", reason: "locked" });
    expect(sessionEntry).toEqual(createEntry());
    expectNoSelectionEffects();
  });

  it.each([
    {
      name: "locked",
      concurrent: createEntry({ modelSelectionLocked: true }),
      outcome: { status: "rejected", reason: "locked" },
    },
    {
      name: "replaced",
      concurrent: createEntry({ sessionId: "session-2" }),
      outcome: { status: "conflict" },
    },
  ])(
    "preserves an in-memory session $name during metadata preparation",
    async ({ concurrent, outcome }) => {
      const metadata = createDeferred<ModelCatalogEntry[]>();
      vi.mocked(loadProviderScopedThinkingCatalog).mockReturnValueOnce(metadata.promise);
      const params = createParams();
      const pending = applySessionModelSelection(params);
      params.sessionStore[params.sessionKey] = concurrent;
      metadata.resolve([]);

      expect(await pending).toMatchObject(outcome);
      expect(params.sessionStore[params.sessionKey]).toBe(concurrent);
      expect(params.sessionEntry).toEqual(createEntry());
      expectNoSelectionEffects();
    },
  );

  it("rejects when the authoritative persisted row became locked", async () => {
    const tempRoot = tempDirs.make("openclaw-model-picker-lock-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:locked-disk";
    const sessionEntry = createEntry();
    const lockedEntry = createEntry({ modelSelectionLocked: true, updatedAt: 2 });
    await replaceSessionEntry({ sessionKey, storePath }, lockedEntry);

    const result = await applySessionModelSelection(
      createParams({ sessionEntry, sessionKey, storePath }),
    );
    expect(result).toMatchObject({ status: "rejected", reason: "locked" });
    expect(sessionEntry).toEqual(lockedEntry);
    expectNoSelectionEffects();
  });

  it("rejects account selection authority revoked during metadata preparation", async () => {
    const metadata = createDeferred<ModelCatalogEntry[]>();
    vi.mocked(loadProviderScopedThinkingCatalog).mockReturnValueOnce(metadata.promise);
    let authorized = true;
    const params = createParams({
      validateAuthProfileSelection: () => (authorized ? undefined : "Select an account you own."),
      request: createRequest("openai", "gpt-4o", {
        profileOverride: "openai:work",
      }),
    });
    const initial = structuredClone(params.sessionEntry);
    const pending = applySessionModelSelection(params);
    authorized = false;
    metadata.resolve([]);

    expect(await pending).toMatchObject({
      status: "rejected",
      message: "Select an account you own.",
    });
    expect(params.sessionEntry).toEqual(initial);
    expectNoSelectionEffects();
  });

  it("refreshes queued work when an idempotent selection only remaps thinking", async () => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      thinkingLevel: "adaptive",
    });
    const result = await applySessionModelSelection(
      createParams({ sessionEntry, currentProvider: "openai", currentModel: "gpt-4o" }),
    );

    expect(result).toMatchObject({
      status: "applied",
      changed: true,
      thinkingRemap: { from: "adaptive", to: "medium", provider: "openai", model: "gpt-4o" },
    });
    expect(sessionEntry.thinkingLevel).toBe("medium");
    expect(effects.triggerSessionPatchHook).toHaveBeenCalledOnce();
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextThinking: expect.objectContaining({ level: "medium" }),
      }),
    );
  });

  it.each([
    {
      name: "session replacement",
      concurrent: createEntry({ sessionId: "session-2", providerOverride: "anthropic" }),
    },
    {
      name: "model switch",
      concurrent: createEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      }),
    },
  ])("returns conflict without a hybrid row after concurrent $name", async ({ concurrent }) => {
    const tempRoot = tempDirs.make("openclaw-model-picker-service-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    const sessionKey = "agent:main:dm:race";
    await replaceSessionEntry({ sessionKey, storePath }, concurrent);

    const result = await applySessionModelSelection(
      createParams({ sessionKey, storePath, sessionEntry }),
    );
    expect(result).toEqual({
      status: "conflict",
      message: "Model change was not applied because the session changed. Retry.",
    });
    expect(sessionEntry).toEqual(concurrent);
    expect(sessionEntry).not.toMatchObject({ modelOverride: "gpt-4o" });
    expectNoSelectionEffects();
  });

  it("keeps idempotent model acknowledgement facts without duplicate effects", async () => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      agentRuntimeOverride: "openclaw",
    });
    const result = await applySessionModelSelection(
      createParams({ sessionEntry, currentProvider: "openai", currentModel: "gpt-4o" }),
    );

    expect(result).toMatchObject({
      status: "applied",
      effectiveModelRef: "openai/gpt-4o",
      changed: false,
    });
    expectNoSelectionEffects();
  });
});
