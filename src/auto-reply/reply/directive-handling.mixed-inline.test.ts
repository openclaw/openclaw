import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { prepareSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import * as authProfileStore from "../../agents/auth-profiles/store-runtime.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import {
  createFixtureProviderModels,
  createFixtureRouteModels,
} from "../../agents/test-helpers/model-fallback-config-fixture.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import {
  applyMixedDirectives,
  createSessionEntry,
} from "./directive-handling.mixed-inline.test-helpers.js";
import { routeReplyDirectivesForTest } from "./get-reply-directives-routing.test-support.js";
import { resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import { buildTestCtx } from "./test-ctx.js";

async function routeDirectives(body: string, cfg: OpenClawConfig) {
  const result = await routeReplyDirectivesForTest(
    buildTestCtx({ Body: body, CommandBody: body, CommandAuthorized: true }),
    { cfg },
  );
  return result.directives;
}

const luna = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" };
const continuedLuna = { kind: "continue", provider: luna.provider, model: luna.id };
const patchedSession = { sessionKey: "agent:main:dm:1", agentId: "main", reason: "patch" };

function applyLunaDirectives(params: Parameters<typeof applyMixedDirectives>[0]) {
  return applyMixedDirectives({ allowedModels: [luna], ...params });
}

function expectQueuedUpdate(fields: Record<string, unknown>) {
  expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(expect.objectContaining(fields));
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

vi.mock("../../skills/discovery/chat-commands.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/discovery/chat-commands.runtime.js")>()),
  prepareSkillCommandsForWorkspace: vi.fn(async () => []),
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

// mock-isolation: Exercise directive persistence independently of sandbox backends and storage.
vi.mock("../../agents/sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatusAsync: vi.fn(async () => ({ sandboxed: false })),
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
    vi.mocked(persistStickyModelSelectionBestEffort).mockReset().mockReturnValue("requested");
    persistenceMocks.persist.mockImplementation(async ({ entry }) => ({
      status: "current",
      entry: { ...entry },
    }));
  });

  afterEach(() => {
    unsubscribeLifecycle();
    vi.restoreAllMocks();
  });
  it.each([
    { name: "stored thinking", prior: "max", hint: "", codex: false },
    { name: "turn-only thinking", prior: "ultra", hint: " /think high", codex: true },
  ] as const)(
    "continues with selected-route metadata and $name",
    async ({ prior, hint, codex }) => {
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
        body: `please reply /model fixture-route/reasoner -s${hint}`,
        cfg: {
          models: createFixtureRouteModels(),
          ...(codex
            ? {
                agents: {
                  defaults: {
                    models: { "fixture-route/reasoner": { agentRuntime: { id: "codex" } } },
                  },
                },
              }
            : {}),
        },
        allowedModels: [
          { provider: "anthropic", id: "claude-opus-4-6", name: "Opus", reasoning: false },
        ],
        sessionEntry: createSessionEntry({ thinkingLevel: prior }),
        storePath: "/tmp/sessions.json",
      });
      expect(result).toMatchObject({
        kind: "continue",
        provider: selected.provider,
        model: selected.id,
        contextTokens: 24_000,
        ...(hint ? { directives: { thinkLevel: "high" } } : {}),
      });
      if (hint) {
        expect(result).toMatchObject({
          directiveAck: { text: expect.stringContaining("Model set to fixture-route/reasoner") },
        });
        if (result.kind !== "continue") {
          throw new Error("Expected the model switch to continue the task");
        }
        expect(result.directiveAck?.text).not.toContain("ultra not supported");
      }
      expect(sessionEntry.thinkingLevel).toBe(prior);
      expectQueuedUpdate({
        key: "agent:main:dm:1",
        nextProvider: selected.provider,
        nextModel: selected.id,
        nextThinking: expect.objectContaining({
          level: prior,
          catalog: expect.arrayContaining([selected]),
          ...(codex ? { agentRuntime: "codex" } : {}),
        }),
      });
      expect(persistenceMocks.persist).toHaveBeenCalledOnce();
      expect(persistenceMocks.persist.mock.calls[0]?.[0].entry.thinkingLevel).toBe(prior);
      expect(triggerSessionPatchHook).toHaveBeenCalledOnce();
      expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
        "Model switched to fixture-route/reasoner.",
        { sessionKey: "agent:main:dm:1", contextKey: "model:fixture-route/reasoner" },
      );
    },
  );

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
    vi.spyOn(authProfileStore, "findPersistedAuthProfileCredentialAsync").mockResolvedValue({
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

    expect(result).toMatchObject(continuedLuna);
    expect(lifecycleEvents).toEqual([{ ...patchedSession, catalogChanged: true }]);
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    await applyMixedDirectives(selection);
    expect(lifecycleEvents).toHaveLength(1);
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
    expect(lifecycleEvents).toEqual([patchedSession]);
  });

  it("forwards automatic provenance for a source-less auth pin", async () => {
    await prepareSharedAuthStoreOwnership();
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: "openai:work",
      authProfileOverrideCompactionCount: 0,
    });
    await applyLunaDirectives({
      body: "/model openai/gpt-5.6-luna -s",
      senderIsOwner: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionEntry,
    });
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
    expectQueuedUpdate({ nextAuthProfileId: "openai:work", nextAuthProfileIdSource: "auto" });
  });

  it("preserves a mixed alias named list as a model selection", async () => {
    const body = "please reply /list -s";
    const cfg: OpenClawConfig = {
      commands: { text: true },
      agents: { defaults: { models: { "openai/gpt-5.6-luna": { alias: "list" } } } },
    };
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const directives = await routeDirectives(body, cfg);
    const { result, sessionEntry } = await applyLunaDirectives({
      body,
      cfg,
      directives,
      modelAliases: ["list"],
      aliasIndex,
      senderIsOwner: true,
    });

    expect(directives).toMatchObject({
      cleaned: "please reply",
      hasModelDirective: true,
      modelDirectiveSource: "alias",
      rawModelDirective: "list",
    });
    expect(result).toMatchObject(continuedLuna);
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
  });

  it("reports immutable config for a mixed agent-default selection", async () => {
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValueOnce("skipped-immutable");
    const { result } = await applyLunaDirectives({
      body: "please reply /model openai/gpt-5.6-luna -a",
      senderIsOwner: true,
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
      name: "queue options",
      body: "please reply\n/queue collect debounce:1500 cap:4 drop:old",
      expected: {
        perMessageQueueMode: "collect",
        perMessageQueueOptions: { debounceMs: 1500, cap: 4, dropPolicy: "old" },
      },
    },
    {
      name: "valid turn hints alongside an invalid exec option",
      body: "please reply\n/exec host=node security=bogus\n/reasoning on",
      expected: {
        directives: { reasoningLevel: "on" },
        directiveAck: { text: expect.stringContaining('Unrecognized exec security "bogus"') },
      },
    },
    {
      name: "turn hints alongside informational and unauthorized siblings",
      body: "please reply\n/trace raw\n/verbose nonsense\n/reasoning on",
      gatewayClientScopes: [],
      expected: {
        directives: { reasoningLevel: "on" },
        directiveAck: { text: expect.stringContaining("/trace is restricted to owners") },
      },
    },
  ])("keeps $name on the current message", async ({ body, expected, gatewayClientScopes }) => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      storePath: "/tmp/sessions.json",
      gatewayClientScopes,
    });
    expect(result).toMatchObject({ kind: "continue", ...expected });
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
      const directives = await routeDirectives(body, cfg);
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

  it("validates unsupported thinking despite an informational sibling", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /fast status /think high",
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
  });

  it("rejects operator-denied directives without session or provider effects", async () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: {
          model: { primary: "fixture/allowed", fallbacks: ["fixture/blocked"] },
          modelPolicy: { allow: ["fixture/*"] },
          models: { "fixture/blocked": { alias: "blocked" } },
        },
      },
      models: createFixtureProviderModels("https://fixture.invalid/v1"),
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
      body: "please reply /model blocked /think off",
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
  });
  it.each([
    { prefix: "", scope: "session", flag: " --global", owner: true, target: "defaults" },
    {
      prefix: "please reply ",
      scope: "session",
      flag: " --global",
      owner: true,
      target: "defaults",
    },
    { prefix: "please reply ", scope: "global", flag: "", owner: false, target: undefined },
  ] as const)(
    "resolves scope=$scope flag=$flag owner=$owner without widening authority",
    async ({ prefix, scope, flag, owner, target }) => {
      const { result, sessionEntry } = await applyLunaDirectives({
        body: `${prefix}/model openai/gpt-5.6-luna${flag}`,
        cfg: { agents: { defaults: { modelSelectionScope: scope } } },
        senderIsOwner: owner,
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
