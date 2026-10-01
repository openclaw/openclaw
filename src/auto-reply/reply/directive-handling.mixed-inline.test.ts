import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as authProfileStore from "../../agents/auth-profiles/store.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import { buildModelAliasIndex, type ModelAliasIndex } from "../../agents/model-selection.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import {
  applyMixedDirectives,
  createSessionEntry,
} from "./directive-handling.mixed-inline.test-helpers.js";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import { buildTestCtx } from "./test-ctx.js";

function routeDirectives(body: string, cfg: OpenClawConfig, modelAliases: string[] = []) {
  return resolveReplyDirectiveRouting({
    commandText: body,
    agentText: body,
    modelAliases,
    canInterpretTextDirectives: true,
    isAuthorizedSender: true,
    isGroup: false,
    wasMentioned: false,
    ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
    cfg,
    agentId: "main",
    resetTriggered: false,
  }).directives;
}

type PersistenceResult =
  | { status: "current"; entry: SessionEntry }
  | { status: "model-selection-locked"; entry: SessionEntry }
  | { status: "lifecycle-invalidated"; error: string; entry?: SessionEntry };

// Runtime eligibility belongs to the published-owner tests; these cases exercise its consumers.
vi.mock("../../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn<
    typeof import("../../agents/model-runtime-choice.js").preparePublishedModelRuntimeChoice
  >(async ({ runtimeId, preferredRuntimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? preferredRuntimeId ?? "codex",
    validate: () => undefined,
  })),
}));

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

const persistenceMocks = vi.hoisted(() => ({
  persist: vi.fn<(params: { entry: SessionEntry }) => Promise<PersistenceResult>>(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: vi.fn(() => []),
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentModelFallbacksOverride: vi.fn(() => undefined),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentIds: vi.fn(() => ({ requestedAgentId: "main", sessionAgentId: "main" })),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../agents/sticky-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sticky-model-selection.js")>()),
  persistStickyModelSelectionBestEffort: vi.fn(),
}));

vi.mock("../../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: (params: { entry: SessionEntry }) => persistenceMocks.persist(params),
}));

describe("mixed inline directives", () => {
  let lifecycleEvents: SessionLifecycleEvent[];
  let unsubscribeLifecycle: () => void;

  beforeEach(() => {
    lifecycleEvents = [];
    unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
    vi.clearAllMocks();
    vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValue("requested");
    persistenceMocks.persist.mockImplementation(async ({ entry }) => ({
      status: "current",
      entry: { ...entry },
    }));
  });

  afterEach(() => {
    unsubscribeLifecycle();
    vi.restoreAllMocks();
  });
  it("continues mixed content with the selected route's context and thinking metadata", async () => {
    const selected: ModelCatalogEntry = {
      provider: "fixture-route",
      id: "reasoner",
      name: "Reasoner",
      api: "openai-responses",
      contextWindow: 48_000,
      contextTokens: 24_000,
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
    };
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([selected]);
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /model fixture-route/reasoner -s",
      cfg: {
        models: {
          providers: {
            "fixture-route": {
              api: "openai-responses",
              baseUrl: "https://fixture.invalid/v1",
              models: [],
            },
          },
        },
      },
      allowedModels: [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Opus", reasoning: false },
      ],
      sessionEntry: createSessionEntry({ thinkingLevel: "max" }),
    });
    expect(result).toMatchObject({
      kind: "continue",
      provider: selected.provider,
      model: selected.id,
      contextTokens: 24_000,
    });
    expect(sessionEntry.thinkingLevel).toBe("max");
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextThinking: expect.objectContaining({
          level: "max",
          catalog: expect.arrayContaining([selected]),
        }),
      }),
    );
  });

  it.each([
    { prefix: "", sibling: "", reason: "model-selection-rejected" },
    { prefix: "please reply ", sibling: "\n/think high", reason: "session-directive-rejected" },
  ])(
    "rejects a restricted model with prefix $prefix and sibling $sibling without persistence",
    async ({ prefix, sibling, reason }) => {
      const sessionEntry = createSessionEntry({ thinkingLevel: "high" });
      const initial = { ...sessionEntry };
      const { result } = await applyMixedDirectives({
        body: `${prefix}/model openai/REJECTED_PRIVATE_TOKEN -s${sibling}`,
        cfg: { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } },
        sessionEntry,
        allowedModels: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Opus" }],
      });
      expect(result).toMatchObject({
        kind: "reply",
        reply: { isError: true, text: expect.stringContaining("is not allowed") },
        preRunRejection: reason,
      });
      expect(sessionEntry).toEqual(initial);
      expect(persistenceMocks.persist).not.toHaveBeenCalled();
      expect(triggerSessionPatchHook).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    },
  );

  it("publishes a mixed profile-only selection only after persistence settles", async () => {
    const persistence = createDeferred<PersistenceResult>();
    const persistenceStarted = createDeferred<SessionEntry>();
    persistenceMocks.persist.mockImplementationOnce(({ entry }) => {
      persistenceStarted.resolve({ ...entry });
      return persistence.promise;
    });
    vi.spyOn(authProfileStore, "findPersistedAuthProfileCredential").mockReturnValue({
      type: "api_key",
      provider: "openai",
      key: "test-key",
    });
    const sessionEntry = createSessionEntry({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "auto",
    });
    const selection = {
      body: "please reply /model openai/gpt-5.6-luna@openai:work -s",
      provider: "openai",
      model: "gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
    };
    const pending = applyMixedDirectives(selection);

    const persisted = await Promise.race([
      persistenceStarted.promise,
      pending.then(({ result }) => {
        throw new Error(`Selection completed before persistence: ${JSON.stringify(result)}`);
      }),
    ]);
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(lifecycleEvents).toEqual([]);
    expect(persisted.authProfileOverrideSource).toBe("user");
    persistence.resolve({ status: "current", entry: persisted });
    const { result } = await pending;

    expect(result).toMatchObject({ kind: "continue", provider: "openai", model: "gpt-5.6-luna" });
    expect(lifecycleEvents).toEqual([
      { sessionKey: "agent:main:dm:1", agentId: "main", reason: "patch", catalogChanged: true },
    ]);
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    await applyMixedDirectives(selection);
    expect(lifecycleEvents).toHaveLength(1);
  });

  it("adopts an authoritative model lock and emits no losing side effects", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persistenceMocks.persist.mockResolvedValueOnce({
      status: "model-selection-locked",
      entry: lockedEntry,
    });

    const { result, sessionStore } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      senderIsOwner: true,
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
      preRunRejection: "session-directive-rejected",
    });
    expect(persistenceMocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ requireModelSelectionUnlocked: true }),
    );
    expect(sessionEntry).toEqual(lockedEntry);
    expect(sessionStore["agent:main:dm:1"]).toEqual(lockedEntry);
    expect(lifecycleEvents).toEqual([]);
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("persists a directive-only reasoning setting and publishes the committed change", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "/reasoning on",
      storePath: "/tmp/sessions.json",
    });
    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: "⚙️ Reasoning visibility enabled." },
    });
    expect(result).not.toHaveProperty("preRunRejection", expect.anything());
    expect(sessionEntry.reasoningLevel).toBe("on");
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(lifecycleEvents).toEqual([
      { sessionKey: "agent:main:dm:1", agentId: "main", reason: "patch" },
    ]);
  });

  it("commits the model switch while keeping its thinking hint on the current turn", async () => {
    const cfg = {
      commands: { text: true },
      agents: {
        defaults: {
          models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } },
        },
      },
    } as OpenClawConfig;
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna /think high",
      cfg,
      sessionEntry: createSessionEntry({ thinkingLevel: "ultra" }),
      storePath: "/tmp/sessions.json",
      provider: "openai",
      model: "gpt-5.6-sol",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      senderIsOwner: true,
    });

    expect(result).toMatchObject({ kind: "continue", provider: "openai", model: "gpt-5.6-luna" });
    expect(sessionEntry.thinkingLevel).toBe("ultra");
    expect(result).toMatchObject({ kind: "continue", directives: { thinkLevel: "high" } });
    if (result.kind !== "continue") {
      throw new Error("Expected the model switch to continue the task");
    }
    expect(result.directiveAck?.text).toContain("Model set to openai/gpt-5.6-luna");
    expect(result.directiveAck?.text).not.toContain("ultra not supported");
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(persistenceMocks.persist.mock.calls[0]?.[0].entry.thinkingLevel).toBe("ultra");
    expect(triggerSessionPatchHook).toHaveBeenCalledOnce();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      "Model switched to openai/gpt-5.6-luna.",
      {
        sessionKey: "agent:main:dm:1",
        contextKey: "model:openai/gpt-5.6-luna",
      },
    );
    expect(refreshQueuedFollowupSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        key: "agent:main:dm:1",
        nextProvider: "openai",
        nextModel: "gpt-5.6-luna",
        nextThinking: expect.objectContaining({
          level: "ultra",
          agentRuntime: "codex",
        }),
      }),
    );
  });

  it("does not acknowledge or mutate a mixed model info directive", async () => {
    const body = "please reply /model";
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const directives = routeDirectives(body, cfg, []);
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg,
      directives,
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { cleaned: "please reply", hasModelDirective: false },
    });
    expect(result).not.toHaveProperty("directiveAck");
    expect(sessionEntry).toEqual(createSessionEntry());
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("forwards automatic provenance for a source-less auth pin", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: "openai:work",
      authProfileOverrideCompactionCount: 0,
    });
    await applyMixedDirectives({
      body: "/model openai/gpt-5.6-luna -s",
      senderIsOwner: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionEntry,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextAuthProfileId: "openai:work",
        nextAuthProfileIdSource: "auto",
      }),
    );
  });

  it("preserves a mixed alias named list as a model selection", async () => {
    const body = "please reply /list -s";
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "list",
          {
            alias: "list",
            ref: { provider: "openai", model: "gpt-5.6-luna" },
          },
        ],
      ]),
      byKey: new Map([["openai/gpt-5.6-luna", ["list"]]]),
    };
    const directives = routeDirectives(body, cfg, ["list"]);
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg,
      directives,
      modelAliases: ["list"],
      aliasIndex,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(directives).toMatchObject({
      cleaned: "please reply",
      hasModelDirective: true,
      modelDirectiveSource: "alias",
      rawModelDirective: "list",
    });
    expect(result).toMatchObject({
      kind: "continue",
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
  });

  it("reports immutable config for a mixed agent-default selection", async () => {
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValueOnce("skipped-immutable");
    const { result } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna -a",
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });
    expect(result).toMatchObject({
      kind: "continue",
      directiveAck: {
        text: "Model set to openai/gpt-5.6-luna for this session. Agent default unchanged because configuration is immutable. Runtime set to codex for this session.",
      },
    });
  });

  it.each([
    {
      prefix: "please reply ",
      provider: "anthropic",
      model: "claude-opus-4-6",
      keepProfile: false,
    },
    { prefix: "", provider: "openai", model: "gpt-5.6-luna", keepProfile: true },
  ])(
    "resets to $provider/$model with compatible auth only",
    async ({ prefix, provider, model, keepProfile }) => {
      const authPin = {
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user" as const,
        authProfileOverrideCompactionCount: 2,
      };
      const sessionEntry = createSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelOverrideSource: "user",
        ...authPin,
      });
      const { result } = await applyMixedDirectives({
        cfg: { agents: { defaults: { model: `${provider}/${model}` } } },
        body: `${prefix}/model default -s`,
        senderIsOwner: true,
        provider: "openai",
        model: "gpt-5.6-sol",
        defaultProvider: provider,
        defaultModel: model,
        sessionEntry,
        allowedModels: [{ provider, id: model, name: model }],
      });
      const ack = {
        text: `Session model reset to configured default (${provider}/${model}).${keepProfile ? " Runtime set to codex for this session." : ""}`,
      };
      expect(result).toMatchObject(
        prefix
          ? { kind: "continue", provider, model, contextTokens: 1_000_000, directiveAck: ack }
          : { kind: "reply", reply: ack },
      );
      expect(sessionEntry.providerOverride).toBeUndefined();
      expect(sessionEntry.modelOverride).toBeUndefined();
      expect(sessionEntry.modelOverrideSource).toBe("default");
      if (keepProfile) {
        expect(sessionEntry).toMatchObject(authPin);
      } else {
        expect(sessionEntry.authProfileOverride).toBeUndefined();
        expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
        expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
      }
      expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({ nextModelOverrideSource: undefined }),
      );
      expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    },
  );

  it("keeps an operator.admin selection session-only", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "/model openai/gpt-5.6-luna --session",
      gatewayClientScopes: ["operator.admin"],
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged. Runtime set to codex for this session.",
      },
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("keeps mixed queue options on the current message", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/queue collect debounce:1500 cap:4 drop:old",
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({
      kind: "continue",
      perMessageQueueMode: "collect",
      perMessageQueueOptions: { debounceMs: 1500, cap: 4, dropPolicy: "old" },
    });
    expect(sessionEntry).toEqual(createSessionEntry());
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it("keeps routed exec policy on its message without changing session placement", async () => {
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const sessionEntry = createSessionEntry({ execHost: "node", execNode: "worker-1" });
    const initialEntry = { ...sessionEntry };
    for (const [body, security, ask] of [
      ["please reply /exec host=gateway node=other security=deny ask=always", "deny", "always"],
      ["please reply again", undefined, undefined],
    ] as const) {
      const directives = routeDirectives(body, cfg);
      const { result } = await applyMixedDirectives({ body, cfg, directives, sessionEntry });
      if (result.kind !== "continue") {
        throw new Error("Expected the message to continue to the agent");
      }
      expect(resolveReplyExecOverrides({ directives: result.directives, sessionEntry })).toEqual({
        host: "node",
        node: "worker-1",
        security,
        ask,
      });
      if (security) {
        expect(result.directiveAck?.text).toContain(
          "Exec policy for this run only (security=deny, ask=always).",
        );
      } else {
        expect(result.directiveAck).toBeUndefined();
      }
      expect(sessionEntry).toEqual(initialEntry);
    }
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it("does not persist a mixed fast-mode hint", async () => {
    const fast = await applyMixedDirectives({ body: "please reply\n/fast on" });
    expect(fast.result).toMatchObject({ kind: "continue", directives: { fastMode: true } });
    expect(fast.sessionEntry.fastMode).toBeUndefined();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it.each(["/fast status"])(
    "validates unsupported thinking despite an informational sibling %j",
    async (sibling) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply ${sibling} /think high`,
        provider: "fixture-route",
        model: "reasoner",
        allowedModels: [
          {
            provider: "fixture-route",
            id: "reasoner",
            name: "Reasoner",
            reasoning: false,
          },
        ],
        gatewayClientScopes: [],
      });
      expect(result).toMatchObject({
        kind: "reply",
        reply: {
          isError: true,
          text: expect.stringContaining('Thinking level "high" is not supported'),
        },
        preRunRejection: "session-directive-rejected",
      });
      expect(sessionEntry).toEqual(createSessionEntry());
      expect(persistenceMocks.persist).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it("keeps valid turn hints when a sibling exec option is invalid", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/exec host=node security=bogus\n/reasoning on",
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { reasoningLevel: "on" },
      directiveAck: { text: expect.stringContaining('Unrecognized exec security "bogus"') },
    });
    expect(sessionEntry).toEqual(createSessionEntry());
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it("keeps informational and unauthorized siblings from persisting turn hints", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/trace raw\n/verbose nonsense\n/reasoning on",
      storePath: "/tmp/sessions.json",
      gatewayClientScopes: [],
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { reasoningLevel: "on" },
      directiveAck: { text: expect.stringContaining("/trace is restricted to owners") },
    });
    expect(sessionEntry.reasoningLevel).toBeUndefined();
    expect(sessionEntry.traceLevel).toBeUndefined();
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it.each(["/model fixture/blocked", "please reply /model blocked /think off"])(
    "rejects operator-denied directive %s without session or provider effects",
    async (body) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          defaults: {
            model: { primary: "fixture/allowed", fallbacks: ["fixture/blocked"] },
            modelPolicy: { allow: ["fixture/*"] },
            models: { "fixture/blocked": { alias: "blocked" } },
          },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: [],
            },
          },
        },
      };
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId: "limited-operator",
        scopes: ["operator.write"],
        assertCurrent: () => {},
        modelPolicy: prepareOperatorModelPolicy({ cfg, policy: { deny: ["fixture/blocked"] } }),
      });
      const sessionEntry = createSessionEntry();
      const before = structuredClone(sessionEntry);
      const { result } = await applyMixedDirectives({
        body,
        cfg,
        sessionEntry,
        operatorAuthority,
        provider: "fixture",
        model: "allowed",
        aliasIndex: buildModelAliasIndex({ cfg, defaultProvider: "fixture" }),
        allowedModels: ["allowed", "blocked"].map((id) => ({ provider: "fixture", id, name: id })),
      });

      expect(result).toMatchObject({
        kind: "reply",
        reply: {
          isError: true,
          text: expect.stringContaining("operator role cannot use this model"),
        },
      });
      expect(sessionEntry).toEqual(before);
      expect(persistenceMocks.persist).not.toHaveBeenCalled();
      expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
      expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    },
  );
  it.each([
    { prefix: "", scope: "agent", flag: "", owner: true, target: "agent" },
    { prefix: "", scope: "session", flag: " --global", owner: true, target: "defaults" },
    {
      prefix: "please reply ",
      scope: "global",
      flag: " --session",
      owner: true,
      target: undefined,
    },
    { prefix: "please reply ", scope: "global", flag: "", owner: false, target: undefined },
  ] as const)(
    "resolves scope=$scope flag=$flag owner=$owner without widening authority",
    async ({ prefix, scope, flag, owner, target }) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `${prefix}/model openai/gpt-5.6-luna${flag}`,
        cfg: { agents: { defaults: { modelSelectionScope: scope } } },
        senderIsOwner: owner,
        allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      });
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-luna",
        modelOverrideSource: "user",
      });
      const acknowledgement = {
        text: expect.stringContaining(target ? "update requested" : "default unchanged"),
      };
      expect(result).toMatchObject(
        prefix
          ? { kind: "continue", directiveAck: acknowledgement }
          : { kind: "reply", reply: acknowledgement },
      );
      if (target) {
        expect(persistStickyModelSelectionBestEffort).toHaveBeenCalledExactlyOnceWith({
          agentId: "main",
          model: "openai/gpt-5.6-luna",
          target,
        });
      } else {
        expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
      }
    },
  );
});
