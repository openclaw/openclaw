import { beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import { clearFollowupQueue, getFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectSessionsPatchEntry } from "../gateway/sessions-patch.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  createModelSelectionInputs,
  selectionMocks,
  useSelectionEffects,
  useSelectionStore,
} from "./apply-session-model-selection.test-support.js";
await vi.hoisted(() => import("./apply-session-model-selection.test-support.js"));
const { effects, placementMocks } = selectionMocks;

const persistedSession = useSelectionStore("openclaw-model-picker-profile-");
const { lifecycleEvents, expectNoSelectionEffects } = useSelectionEffects();

import {
  applySessionModelSelectionInternal as applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "./apply-session-model-selection.js";

const { catalog, createEntry, createSelectedEntry, createParams, createFixtureParams } =
  createModelSelectionInputs();

function select(overrides: Partial<ApplySessionModelSelectionParams>) {
  return applySessionModelSelection(createParams(overrides));
}

function createRequest(
  provider: string,
  model: string,
  overrides: Partial<ApplySessionModelSelectionParams["request"]> = {},
): ApplySessionModelSelectionParams["request"] {
  return { provider, model, isDefault: false, runtime: { kind: "unchanged" }, ...overrides };
}

beforeAll(() => prepareSharedAuthStoreOwnership());

it.each([false, true])("uses configured default only with reset intent=%s", async (reset) => {
  const modelCatalog = [
    { provider: "fixture", id: "automatic", name: "Automatic" },
    { provider: "fixture", id: "manual", name: "Manual" },
  ];
  const params = createFixtureParams(
    modelCatalog,
    {
      model: "fixture/automatic",
      modelPolicy: { allow: ["fixture/manual"] },
    },
    {
      defaultModel: "stale-default-hint",
      request: createRequest("fixture", reset ? "manual" : "automatic", {
        isDefault: true,
        ...(reset ? { resetToDefault: true as const } : {}),
      }),
    },
  );
  const result = await applySessionModelSelection(params);
  expect(result).toMatchObject(
    reset
      ? { status: "applied", provider: "fixture", model: "automatic" }
      : { status: "rejected", reason: "not-allowed" },
  );
  expect(params.sessionEntry.modelOverride).toBe(reset ? undefined : "manual");
});

it.each<[Partial<ApplySessionModelSelectionParams>, { reason: string; message?: string }]>([
  [{ request: createRequest("missing-provider", "reasoner") }, { reason: "unknown-provider" }],
  [
    {
      request: createRequest("openai", "gpt-5.6-luna", {
        runtime: { kind: "set", runtime: "missing-runtime" },
      }),
    },
    { reason: "invalid-runtime" },
  ],
  [
    {
      request: createRequest("anthropic", "claude-opus-4-6", {
        isDefault: true,
        runtime: { kind: "set", runtime: "codex" },
      }),
    },
    { reason: "invalid-runtime", message: 'Runtime "codex" is not supported for anthropic.' },
  ],
  [
    { cfg: { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } } },
    { reason: "not-allowed", message: "Model openai/gpt-4o is not available for this agent." },
  ],
])("rejects invalid selection %# without mutation or effects", async (overrides, expected) => {
  const params = createParams({
    sessionEntry: createEntry({ thinkingLevel: "high" }),
    modelCatalog: [catalog[0]!],
    thinkingCatalog: [catalog[0]!],
    ...overrides,
  });
  const initial = structuredClone(params.sessionEntry);
  const result = await applySessionModelSelection(params);
  expect(result).toMatchObject({ status: "rejected", ...expected });
  expect(params.sessionEntry).toEqual(initial);
  expectNoSelectionEffects();
  expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
});

it.each([false, true])(
  "refreshes inherited thinking only with pending work=%s",
  async (pending) => {
    const params = createParams();
    const observed = {
      ...catalog[1]!,
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    } satisfies ModelCatalogEntry;
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([observed]);
    if (pending) {
      getFollowupQueue(params.sessionKey, { mode: "followup" }).droppedCount = 1;
    }
    try {
      expect(await applySessionModelSelection(params)).toMatchObject({ status: "applied" });
      expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledTimes(pending ? 1 : 0);
      expect(effects.refreshQueuedFollowupSession.mock.calls).toMatchObject([
        [
          {
            nextThinking: {
              level: undefined,
              catalog: expect.arrayContaining([pending ? observed : catalog[1]]),
            },
          },
        ],
      ]);
    } finally {
      clearFollowupQueue(params.sessionKey);
    }
  },
);

it.each([undefined, { allow: ["openai/*"] }])(
  "persists an off-catalog selection under policy %j without credentials",
  async (modelPolicy) => {
    const sessionEntry = createEntry({ thinkingLevel: "high" });
    const cfg: OpenClawConfig = { agents: { defaults: { modelPolicy } } };
    const result = await select({
      cfg,
      sessionEntry,
      modelCatalog: [catalog[0]!],
      thinkingCatalog: [catalog[0]!],
      request: createRequest("openai", "gpt-5.6-luna"),
    });
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
  const { sessionEntry, sessionKey, storePath } = await persistedSession(
    createSelectedEntry("openai", "gpt-5.6-luna", {
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "auto",
    }),
    "agent:main:dm:profile",
  );
  let publishedEntry: SessionEntry | undefined;
  const unsubscribe = onSessionLifecycleEvent(() => {
    publishedEntry = loadSessionEntryReadOnly({ sessionKey, storePath });
  });
  try {
    const result = await select({
      sessionEntry,
      sessionKey,
      storePath,
      currentProvider: "openai",
      currentModel: "gpt-5.6-luna",
      modelCatalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
      request: createRequest("openai", "gpt-5.6-luna", {
        profileOverride: "openai:work",
      }),
    });

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
  const result = await select({
    sessionEntry,
    sessionKey,
    canPersistStickyModelSelection: true,
    request: createRequest("openai", "gpt-4o", {
      isDefault: true,
      alias: "Fast",
      profileOverride: "openai:work",
    }),
  });

  expect(result).toMatchObject({
    status: "applied",
    provider: "openai",
    model: "gpt-4o",
    effectiveModelRef: "openai/gpt-4o",
    changed: true,
    contextTokens: 16_000,
    configuredDefaultUpdate: "requested",
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
  for (const key of ["model", "modelProvider", "contextTokens", "contextBudgetStatus"] as const) {
    expect(sessionEntry[key]).toBeUndefined();
  }
  expect(effects.triggerSessionPatchHook.mock.calls).toMatchObject([
    [{ sessionKey, patch: { key: sessionKey, model: "openai/gpt-4o" } }],
  ]);
  await vi.waitFor(() => expect(effects.mutateConfigFileWithRetry).toHaveBeenCalledOnce());
  expect(effects.refreshQueuedFollowupSession.mock.calls).toMatchObject([[{ key: sessionKey }]]);
  expect(effects.enqueueSystemEvent).toHaveBeenCalledWith(
    "Model switched to Fast (openai/gpt-4o).",
    { sessionKey, contextKey: "model:openai/gpt-4o" },
  );
});

it.each(["anthropic", "openai"])(
  "resets to a %s default and preserves only compatible auth",
  async (provider) => {
    const compatible = provider === "openai";
    const model = compatible ? "gpt-4o" : "claude-opus-4-6";
    const currentModel = compatible ? "gpt-4.1" : "gpt-4o";
    const sessionEntry = createSelectedEntry("openai", currentModel, {
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 3,
      ...(!compatible ? { agentHarnessId: "codex", agentRuntimeOverride: "codex" } : {}),
    });
    const result = await select({
      sessionEntry,
      defaultProvider: provider,
      defaultModel: model,
      currentProvider: "openai",
      currentModel,
      canPersistStickyModelSelection: compatible,
      request: createRequest(provider, model, {
        runtime: compatible ? { kind: "unchanged" } : { kind: "clear" },
      }),
    });

    expect(result).toMatchObject({ status: "applied", changed: true });
    expect(result).not.toHaveProperty("configuredDefaultUpdate");
    if (!compatible) {
      expect(result).toMatchObject({ runtimeChange: { kind: "clear" } });
      expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
      expect(sessionEntry.agentHarnessId).toBe("codex");
    }
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideRouteResolution).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBe("default");
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

  await select({ cfg, canPersistStickyModelSelection: true });

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
      expect(result).toMatchObject({
        ok: true,
        entry: {
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
        },
      });
      expect(
        result.ok && [result.entry.agentRuntimeOverride, result.entry.nativeRuntimeConsent],
      ).toEqual([undefined, undefined]);
    }
    expect(sessionEntry).toEqual(initial);
  },
);

it.each([undefined, "openclaw", "claude-cli"])(
  "persists SDK model-only selection with inherited runtime %s",
  async (agentRuntimeOverride) => {
    const { sessionEntry, sessionKey, storePath } = await persistedSession(
      createEntry({
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        ...(agentRuntimeOverride
          ? { agentRuntimeOverride, nativeRuntimeConsent: agentRuntimeOverride }
          : {}),
      }),
      "agent:main:dm:runtime-compat",
    );
    const result = await select({
      cfg: {
        agents: {
          defaults: { models: { "openai/gpt-4o": { agentRuntime: { id: "openclaw" } } } },
        },
      },
      sessionEntry,
      sessionKey,
      storePath,
    });
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

it.each(["memory", "disk"])("rejects a stale snapshot when the %s row is locked", async (store) => {
  const sessionEntry = createEntry();
  const lockedEntry = createEntry({ modelSelectionLocked: true, updatedAt: 2 });
  const sessionKey = "agent:main:dm:locked";
  const persisted = store === "disk" ? await persistedSession(lockedEntry, sessionKey) : {};
  const result = await select({
    ...persisted,
    sessionEntry,
    sessionKey,
    ...(store === "memory" ? { sessionStore: { [sessionKey]: lockedEntry } } : {}),
  });

  expect(result).toMatchObject({ status: "rejected", reason: "locked" });
  expect(sessionEntry).toEqual(store === "disk" ? lockedEntry : createEntry());
  expectNoSelectionEffects();
});

it.each(
  [
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
  ].flatMap(({ name, concurrent, outcome }) =>
    ["metadata", "placement"].map((phase) => ({ name, concurrent, outcome, phase })),
  ),
)(
  "preserves an in-memory session $name during $phase preparation",
  async ({ concurrent, outcome, phase }) => {
    const entered = createDeferred();
    const metadata = createDeferred<ModelCatalogEntry[]>();
    if (phase === "metadata") {
      vi.mocked(loadProviderScopedThinkingCatalog).mockImplementationOnce(() => {
        entered.resolve();
        return metadata.promise;
      });
    } else {
      placementMocks.prepareRuntimeRefresh.mockImplementationOnce(async () => {
        entered.resolve();
        await metadata.promise;
        return { placement: undefined, assertCurrent: () => {}, release: () => {} };
      });
    }
    const params = createParams({ thinkingCatalog: [] });
    const pending = applySessionModelSelection(params);
    await awaitGateBeforeSettlement(
      entered.promise,
      pending,
      `Model selection did not enter ${phase} preparation`,
    );
    params.sessionStore[params.sessionKey] = concurrent;
    metadata.resolve([]);

    expect(await pending).toMatchObject(outcome);
    expect(params.sessionStore[params.sessionKey]).toBe(concurrent);
    expect(params.sessionEntry).toEqual(createEntry());
    expectNoSelectionEffects();
  },
);

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

it("preserves the persisted requested level across reasoning capability switches", async () => {
  const { sessionEntry, sessionKey, storePath } = await persistedSession(
    createEntry({ thinkingLevel: "high" }),
    "agent:main:dm:thinking-switch",
  );
  const reasoner = { ...catalog[0]!, name: "Reasoner", reasoning: true };
  const plain = { ...catalog[1]!, name: "Plain", reasoning: false };
  const thinkingCatalog = [reasoner, plain];
  for (const [current, selected] of [
    [reasoner, plain],
    [plain, reasoner],
  ] as const) {
    const result = await select({
      sessionEntry,
      sessionKey,
      storePath,
      modelCatalog: thinkingCatalog,
      thinkingCatalog,
      currentProvider: current.provider,
      currentModel: current.id,
      request: createRequest(selected.provider, selected.id),
    });
    expect(result.status).toBe("applied");
    expect(loadSessionEntryReadOnly({ sessionKey, storePath })?.thinkingLevel).toBe("high");
  }
});

it.each<[string, SessionEntry]>([
  ["session replacement", createEntry({ sessionId: "session-2", providerOverride: "anthropic" })],
  ["model switch", createSelectedEntry("openai", "gpt-5.5")],
])("returns conflict without a hybrid row after concurrent %s", async (_name, concurrent) => {
  const sessionEntry = createSelectedEntry("anthropic", "claude-opus-4-6");
  const { sessionKey, storePath } = await persistedSession(concurrent, "agent:main:dm:race");

  const result = await select({ sessionKey, storePath, sessionEntry });
  expect(result).toEqual({
    status: "conflict",
    message: "Model change was not applied because the session changed. Retry.",
  });
  expect(sessionEntry).toEqual(concurrent);
  expect(sessionEntry).not.toMatchObject({ modelOverride: "gpt-4o" });
  expectNoSelectionEffects();
});

it("keeps idempotent model acknowledgement facts without duplicate effects", async () => {
  const sessionEntry = createSelectedEntry("openai", "gpt-4o", {
    agentRuntimeOverride: "openclaw",
    thinkingLevel: "adaptive",
  });
  const result = await select({
    sessionEntry,
    currentProvider: "openai",
    currentModel: "gpt-4o",
  });

  expect(result).toMatchObject({
    status: "applied",
    effectiveModelRef: "openai/gpt-4o",
    changed: false,
  });
  expectNoSelectionEffects();
  expect(result).not.toHaveProperty("thinkingRemap");
  expect(sessionEntry.thinkingLevel).toBe("adaptive");
});
