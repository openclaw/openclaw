import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import { preparePublishedModelRuntimeChoice } from "../agents/model-runtime-choice.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import {
  applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "../plugin-sdk/model-session-runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { createModelSelectionInputs } from "./apply-session-model-selection.test-support.js";

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
vi.mock("../infra/system-events.js", factories.systemEvents);
vi.mock("../auto-reply/reply/queue.js", factories.queue);
vi.mock("../gateway/session-patch-hooks.js", factories.patchHooks);
vi.mock("../config/config.js", factories.config);
vi.mock("../logging/subsystem.js", factories.logging);
vi.mock("../gateway/session-worker-placement-context.js", factories.placementContext);
vi.mock("../gateway/worker-environments/placement-session-runtime.js", factories.placementRuntime);

let lifecycleEvents: SessionLifecycleEvent[];
let unsubscribeLifecycle: () => void;
beforeEach(() => {
  resetMocks();
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
  lifecycleEvents = [];
  unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
});
afterEach(() => {
  unsubscribeLifecycle();
  vi.clearAllMocks();
});

function restrictedSelection(options: { empty?: boolean; assertCurrent?: () => void } = {}) {
  const { createParams, createEntry } = createModelSelectionInputs();
  const models = ["primary", "fallback", "manual"].map((id) => ({
    provider: "fixture",
    id,
    name: id,
    reasoning: false,
  }));
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "fixture/primary", fallbacks: ["fixture/fallback"] },
        modelPolicy: { allow: ["fixture/primary", "fixture/manual"] },
      },
    },
    models: {
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
            maxTokens: 1024,
          })),
        },
      },
    },
  };
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "limited-operator",
    scopes: ["operator.write"],
    assertCurrent: options.assertCurrent ?? (() => {}),
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { allow: options.empty ? [] : ["fixture/fallback", "fixture/manual"] },
    }),
  });
  const params: ApplySessionModelSelectionParams = createParams({
    cfg,
    defaultProvider: "fixture",
    defaultModel: "primary",
    currentProvider: "fixture",
    currentModel: "manual",
    sessionEntry: createEntry({ providerOverride: "fixture", modelOverride: "manual" }),
    modelCatalog: models,
    thinkingCatalog: models,
    request: {
      provider: "fixture",
      model: "manual",
      isDefault: false,
      runtime: { kind: "unchanged" },
    },
  });
  return {
    params,
    operatorAuthority,
    run: () =>
      withGatewayToolCallerIdentity(
        { agentId: params.agentId, sessionKey: params.sessionKey, operatorAuthority },
        () => applySessionModelSelection(params),
      ),
  };
}

it.each([false, true])(
  "constrains Default to permitted automatic models without granting manual fallback selection (%s)",
  async (reset) => {
    const { params, run } = restrictedSelection();
    params.request = {
      provider: "fixture",
      model: "fallback",
      isDefault: false,
      ...(reset ? { resetToDefault: true as const } : {}),
      runtime: { kind: "unchanged" },
    };
    const before = structuredClone(params.sessionEntry);
    const result = await run();

    expect(result).toMatchObject(
      reset
        ? { status: "applied", provider: "fixture", model: "fallback" }
        : { status: "rejected", reason: "not-allowed" },
    );
    if (reset) {
      expect(params.sessionEntry.modelOverride).toBeUndefined();
    } else {
      expect(params.sessionEntry).toEqual(before);
    }
  },
);

it.each([false, true])(
  "rejects denied manual selection or an empty role before effects (empty=%s)",
  async (empty) => {
    const { params, run } = restrictedSelection({ empty });
    params.request = {
      provider: "fixture",
      model: "primary",
      isDefault: false,
      ...(empty ? { resetToDefault: true as const } : {}),
      runtime: { kind: "unchanged" },
    };
    const before = structuredClone(params.sessionEntry);
    const result = await run();

    expect(result).toMatchObject({
      status: "rejected",
      reason: "not-allowed",
      message: expect.stringContaining("operator role"),
    });
    expect(params.sessionEntry).toEqual(before);
    expect(lifecycleEvents).toEqual([]);
    expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  },
);

it("rechecks original operator authority after model preparation before selection mutation", async () => {
  let current = true;
  const { params, run } = restrictedSelection({
    assertCurrent: () => {
      if (!current) {
        throw new Error("operator policy changed");
      }
    },
  });
  params.request.runtime = { kind: "set", runtime: "openclaw" };
  vi.mocked(preparePublishedModelRuntimeChoice).mockImplementationOnce(
    async ({ runtimeId, preferredRuntimeId }) => {
      current = false;
      return {
        kind: "ready",
        runtimeId: runtimeId ?? preferredRuntimeId ?? "openclaw",
        validate: () => undefined,
      };
    },
  );
  const before = structuredClone(params.sessionEntry);

  expect(await run()).toMatchObject({
    status: "rejected",
    message: "operator policy changed",
  });
  expect(params.sessionEntry).toEqual(before);
  expect(lifecycleEvents).toEqual([]);
  expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
});

it.each(["operator", "unprofiled"] as const)(
  "preserves direct invocation boundaries for %s callers",
  async (source) => {
    const { params, operatorAuthority } = restrictedSelection();
    const isOperator = source === "operator";
    let current = true;
    params.request.runtime = { kind: "set", runtime: "openclaw" };
    params.request.model = isOperator ? "manual" : "primary";
    vi.mocked(preparePublishedModelRuntimeChoice).mockImplementationOnce(async () => {
      current = !isOperator;
      return { kind: "ready", runtimeId: "openclaw", validate: () => undefined };
    });
    const before = structuredClone(params.sessionEntry);
    const result = await withOperatorToolGatewayAuthority(
      {
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (!current) {
            throw new Error("direct invocation authority expired");
          }
        },
        ...(isOperator
          ? {
              authenticatedUserProfile: {
                profileId: operatorAuthority.profileId,
                displayName: "Operator Fixture",
                hasAvatar: false,
                updatedAt: 1,
              },
              operatorRunAuthority: operatorAuthority,
            }
          : {}),
      },
      () => applySessionModelSelection(params),
    );

    expect(operatorAuthority.assertCurrent).not.toThrow();
    if (isOperator) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: "not-allowed",
        message: "direct invocation authority expired",
      });
      expect(params.sessionEntry).toEqual(before);
      expect(lifecycleEvents).toEqual([]);
      expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ status: "applied", provider: "fixture", model: "primary" });
      expect(params.sessionEntry.modelOverride).toBeUndefined();
      expect(lifecycleEvents).toHaveLength(1);
      expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    }
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  },
);

it.each(["agent-tool", "request", "direct-tool", "unbound-operator"] as const)(
  "the public SDK cannot omit operator model policy in %s context",
  async (source) => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { model: "fixture/allowed" } },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
    };
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "operator-fixture",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({ cfg, policy: { allow: ["fixture/allowed"] } }),
    });
    const profile = {
      profileId: authority.profileId,
      displayName: "Operator Fixture",
      hasAvatar: false,
      updatedAt: 1,
    };
    const catalog = ["allowed", "blocked"].map((id) => ({ provider: "fixture", id, name: id }));
    const { createParams, createEntry } = createModelSelectionInputs();
    const params = createParams({
      cfg,
      defaultProvider: "fixture",
      defaultModel: "allowed",
      currentProvider: "fixture",
      currentModel: "allowed",
      sessionEntry: createEntry({ providerOverride: "fixture", modelOverride: "allowed" }),
      modelCatalog: catalog,
      thinkingCatalog: catalog,
      request: {
        provider: "fixture",
        model: "blocked",
        isDefault: false,
        runtime: { kind: "unchanged" },
      },
    });
    const before = structuredClone(params.sessionEntry);
    const run = () => applySessionModelSelection(params);
    const result =
      source === "agent-tool"
        ? await withGatewayToolCallerIdentity(
            { agentId: "main", sessionKey: params.sessionKey, operatorAuthority: authority },
            run,
          )
        : source === "request"
          ? await withPluginRuntimeGatewayRequestScope(
              {
                client: createSyntheticPluginRuntimeClient({
                  authenticatedUserProfile: profile,
                  operatorRunAuthority: authority,
                  scopes: ["operator.write"],
                }),
                isWebchatConnect: () => false,
              },
              run,
            )
          : await withOperatorToolGatewayAuthority(
              {
                authenticatedUserProfile: profile,
                scopes: ["operator.write"],
                ...(source === "direct-tool" ? { operatorRunAuthority: authority } : {}),
              },
              run,
            );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "not-allowed",
      message: expect.stringContaining(
        source === "unbound-operator"
          ? "requires original Gateway authority"
          : "operator role cannot use this model",
      ),
    });
    expect(params.sessionEntry).toEqual(before);
    expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  },
);
