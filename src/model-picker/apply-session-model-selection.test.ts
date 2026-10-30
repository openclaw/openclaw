import { beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { prepareSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import { clearFollowupQueue, getFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  createModelSelectionInputs,
  createRequest,
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

beforeAll(() => prepareSharedAuthStoreOwnership());

it.each([false, true])("uses configured default only with reset intent=%s", async (reset) => {
  const params = createFixtureParams(
    ["automatic", "manual"].map((id) => ({ provider: "fixture", id, name: id })),
    { model: "fixture/automatic", modelPolicy: { allow: ["fixture/manual"] } },
    {
      defaultModel: "stale-default-hint",
      canPersistStickyModelSelection: true,
      sessionEntry: createEntry({
        providerOverride: "fixture",
        modelOverride: "manual",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        nativeRuntimeConsent: "codex",
      }),
      request: createRequest("fixture", reset ? "manual" : "automatic", {
        isDefault: true,
        runtime: { kind: "clear" },
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
  if (reset) {
    expect(result).toMatchObject({ runtimeChange: { kind: "clear" } });
  }
  expect([
    params.sessionEntry.agentRuntimeOverride,
    params.sessionEntry.nativeRuntimeConsent,
  ]).toEqual(reset ? [undefined, undefined] : ["codex", "codex"]);
  expect(params.sessionEntry.agentHarnessId).toBe("codex");
  expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
});

it.each([
  ["missing-provider", "reasoner", undefined, "unknown-provider"],
  ["openai", "gpt-5.6-luna", "missing-runtime", "invalid-runtime"],
  ["anthropic", "claude-opus-4-6", "codex", "invalid-runtime"],
  ["openai", "gpt-4o", undefined, "not-allowed"],
] as const)(
  "rejects %s/%s (%s) without mutation or effects",
  async (provider, model, runtime, reason) => {
    const params = createParams({
      sessionEntry: createEntry({ thinkingLevel: "high" }),
      modelCatalog: [catalog[0]!],
      thinkingCatalog: [catalog[0]!],
      cfg:
        reason === "not-allowed"
          ? { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } }
          : {},
      request: createRequest(provider, model, {
        isDefault: provider === "anthropic",
        runtime: runtime ? { kind: "set", runtime } : { kind: "unchanged" },
      }),
    });
    const initial = structuredClone(params.sessionEntry);
    const result = await applySessionModelSelection(params);
    expect(result).toMatchObject({ status: "rejected", reason });
    expect(params.sessionEntry).toEqual(initial);
    expectNoSelectionEffects();
    expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  },
);

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
      const thinking = effects.refreshQueuedFollowupSession.mock.calls[0]?.[0].nextThinking;
      expect(thinking.level).toBeUndefined();
      expect(thinking.catalog).toContainEqual(pending ? observed : catalog[1]);
    } finally {
      clearFollowupQueue(params.sessionKey);
    }
  },
);

it.each([undefined, { allow: ["openai/*"] }])(
  "persists an off-catalog selection under policy %j without credentials",
  async (modelPolicy) => {
    const sessionEntry = createEntry({ thinkingLevel: "high" });
    const result = await select({
      cfg: { agents: { defaults: { modelPolicy } } },
      sessionEntry,
      modelCatalog: [catalog[0]!],
      thinkingCatalog: [catalog[0]!],
      request: createRequest("openai", "gpt-5.6-luna"),
    });
    expect(result).toMatchObject({ status: "applied", provider: "openai", model: "gpt-5.6-luna" });
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
  const sessionEntry = createEntry();
  const cfg = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
  const draft = {
    agents: { ...cfg.agents, entries: { main: { model: "anthropic/claude-sonnet-4-6" } } },
  };
  effects.mutateConfigFileWithRetry.mockImplementationOnce(
    async ({ mutate }: { mutate: (config: OpenClawConfig) => string }) => ({
      nextConfig: draft,
      result: mutate(draft),
    }),
  );
  const result = await select({
    cfg,
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
  expect(effects.triggerSessionPatchHook.mock.calls[0]?.[0].sessionKey).toBe(sessionKey);
  await vi.waitFor(() => expect(effects.mutateConfigFileWithRetry).toHaveBeenCalledOnce());
  expect(draft.agents.defaults.model).toBe("anthropic/claude-opus-4-6");
  expect(draft.agents.entries.main.model).toBe("openai/gpt-4o");
  expect(effects.refreshQueuedFollowupSession.mock.calls).toMatchObject([[{ key: sessionKey }]]);
  expect(effects.enqueueSystemEvent).toHaveBeenCalledWith(
    "Model switched to Fast (openai/gpt-4o).",
    { sessionKey, contextKey: "model:openai/gpt-4o" },
  );
});

it.each([undefined, "openclaw", "claude-cli"])(
  "persists SDK model-only selection with inherited runtime %s",
  async (agentRuntimeOverride) => {
    const target = await persistedSession(
      createEntry({
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        ...(agentRuntimeOverride
          ? { agentRuntimeOverride, nativeRuntimeConsent: agentRuntimeOverride }
          : {}),
      }),
      "agent:main:dm:runtime-compat",
    );
    const cfg = {
      agents: { defaults: { models: { "openai/gpt-4o": { agentRuntime: { id: "openclaw" } } } } },
    };
    const result = await select({ ...target, cfg });
    expect(result).toMatchObject({
      status: "applied",
      provider: "openai",
      model: "gpt-4o",
      agentRuntime: "openclaw",
    });
    const compatible = agentRuntimeOverride === "openclaw";
    const stored = loadSessionEntryReadOnly(target);
    expect(stored).toMatchObject({ providerOverride: "openai", modelOverride: "gpt-4o" });
    expect([stored?.agentRuntimeOverride, stored?.nativeRuntimeConsent]).toEqual(
      compatible ? ["openclaw", "openclaw"] : [undefined, undefined],
    );
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
    request: createRequest("openai", "gpt-4o", { profileOverride: "openai:work" }),
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
  const target = await persistedSession(
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
      ...target,
      modelCatalog: thinkingCatalog,
      thinkingCatalog,
      currentProvider: current.provider,
      currentModel: current.id,
      request: createRequest(selected.provider, selected.id),
    });
    expect(result.status).toBe("applied");
    expect(loadSessionEntryReadOnly(target)?.thinkingLevel).toBe("high");
  }
});

it.each<[string, SessionEntry]>([
  ["session replacement", createEntry({ sessionId: "session-2", providerOverride: "anthropic" })],
  ["model switch", createSelectedEntry("openai", "gpt-5.5")],
])("returns conflict without a hybrid row after concurrent %s", async (_name, concurrent) => {
  const sessionEntry = createSelectedEntry("anthropic", "claude-opus-4-6");
  const { sessionKey, storePath } = await persistedSession(concurrent, "agent:main:dm:race");

  const result = await select({ sessionKey, storePath, sessionEntry });
  expect(result).toMatchObject({ status: "conflict" });
  expect(sessionEntry).toEqual(concurrent);
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
