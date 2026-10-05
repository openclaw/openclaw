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

it.each([
  { model: "fallback", reset: false, empty: false, applied: false },
  { model: "fallback", reset: true, empty: false, applied: true },
  { model: "primary", reset: false, empty: false, applied: false },
  { model: "primary", reset: true, empty: true, applied: false },
])(
  "enforces operator policy for $model (reset=$reset, empty=$empty)",
  async ({ model, reset, empty, applied }) => {
    const { params, run } = restrictedSelection({ empty });
    params.request.model = model;
    if (reset) {
      params.request.resetToDefault = true;
    }
    const before = structuredClone(params.sessionEntry);
    const result = await run();
    if (applied) {
      expect(result).toMatchObject({ status: "applied", provider: "fixture", model: "fallback" });
      expect(params.sessionEntry.modelOverride).toBeUndefined();
    } else {
      expect(result).toMatchObject({ status: "rejected", reason: "not-allowed" });
      expect(params.sessionEntry).toEqual(before);
      if (model === "primary") {
        expect(result).toMatchObject({ message: expect.stringContaining("operator role") });
        expectNoSelectionEffects();
      }
    }
  },
);

function expectNoSelectionEffects() {
  expect(lifecycleEvents).toEqual([]);
  expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
  expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
  expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
  expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
}

it.each(["caller", "operator", "unprofiled"] as const)(
  "rechecks %s authority after model preparation before mutation",
  async (source) => {
    let current = true;
    const message =
      source === "caller" ? "operator policy changed" : "direct invocation authority expired";
    const assertCurrent = () => {
      if (!current) {
        throw new Error(message);
      }
    };
    const { params, operatorAuthority, run } = restrictedSelection(
      source === "caller" ? { assertCurrent } : {},
    );
    params.request.runtime = { kind: "set", runtime: "openclaw" };
    params.request.model = source === "unprofiled" ? "primary" : "manual";
    vi.mocked(preparePublishedModelRuntimeChoice).mockImplementationOnce(async () => {
      current = source === "unprofiled";
      return { kind: "ready", runtimeId: "openclaw", validate: () => undefined };
    });
    const before = structuredClone(params.sessionEntry);
    const result =
      source === "caller"
        ? await run()
        : await withOperatorToolGatewayAuthority(
            {
              scopes: ["operator.write"],
              assertCurrent,
              ...(source === "operator"
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
    if (source !== "caller") {
      expect(operatorAuthority.assertCurrent).not.toThrow();
    }
    if (source === "unprofiled") {
      expect(result).toMatchObject({ status: "applied", provider: "fixture", model: "primary" });
      expect(params.sessionEntry.modelOverride).toBeUndefined();
      expect(lifecycleEvents).toHaveLength(1);
      expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ status: "rejected", reason: "not-allowed", message });
      expect(params.sessionEntry).toEqual(before);
      expect(lifecycleEvents).toEqual([]);
      expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    }
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  },
);

it.each(["request", "direct-tool", "unbound-operator"] as const)(
  "the public SDK cannot omit operator model policy in %s context",
  async (source) => {
    const { params, operatorAuthority: authority } = restrictedSelection();
    params.request.model = "primary";
    const profile = {
      profileId: authority.profileId,
      displayName: "Operator Fixture",
      hasAvatar: false,
      updatedAt: 1,
    };
    const before = structuredClone(params.sessionEntry);
    const run = () => applySessionModelSelection(params);
    const result =
      source === "request"
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
    expectNoSelectionEffects();
  },
);
