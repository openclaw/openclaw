import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import {
  applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "../plugin-sdk/model-session-runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createModelSelectionInputs,
  selectionMocks,
  useSelectionEffects,
} from "./apply-session-model-selection.test-support.js";
await vi.hoisted(() => import("./apply-session-model-selection.test-support.js"));
const { effects, prepareRuntime } = selectionMocks;

const { lifecycleEvents, expectNoSelectionEffects: expectNoPublishedEffects } =
  useSelectionEffects();

function restrictedSelection(options: { empty?: boolean; assertCurrent?: () => void } = {}) {
  const { createFixtureParams } = createModelSelectionInputs();
  const models = ["primary", "fallback", "manual"].map((id) => ({
    provider: "fixture",
    id,
    name: id,
    reasoning: false,
  }));
  const params: ApplySessionModelSelectionParams = createFixtureParams(
    models,
    {
      model: { primary: "fixture/primary", fallbacks: ["fixture/fallback"] },
      modelPolicy: { allow: ["fixture/primary", "fixture/manual"] },
    },
    {},
    1024,
  );
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "limited-operator",
    scopes: ["operator.write"],
    assertCurrent: options.assertCurrent ?? (() => {}),
    modelPolicy: prepareOperatorModelPolicy({
      cfg: params.cfg,
      policy: { allow: options.empty ? [] : ["fixture/fallback", "fixture/manual"] },
    }),
  });
  const profile = {
    profileId: operatorAuthority.profileId,
    displayName: "Operator Fixture",
    hasAvatar: false,
    updatedAt: 1,
  };
  return {
    params,
    operatorAuthority,
    profile,
    direct: (kind: "profiled" | "unprofiled" | "unbound", assertCurrent?: () => void) =>
      withOperatorToolGatewayAuthority(
        {
          scopes: ["operator.write"],
          assertCurrent,
          ...(kind !== "unprofiled" ? { authenticatedUserProfile: profile } : {}),
          ...(kind === "profiled" ? { operatorRunAuthority: operatorAuthority } : {}),
        },
        () => applySessionModelSelection(params),
      ),
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
  expectNoPublishedEffects();
  expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
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
    const { params, operatorAuthority, direct, run } = restrictedSelection(
      source === "caller" ? { assertCurrent } : {},
    );
    params.request.runtime = { kind: "set", runtime: "openclaw" };
    params.request.model = source === "unprofiled" ? "primary" : "manual";
    prepareRuntime.mockImplementationOnce(async () => {
      current = source === "unprofiled";
      return { kind: "ready", runtimeId: "openclaw", validate: () => undefined };
    });
    const before = structuredClone(params.sessionEntry);
    const result =
      source === "caller"
        ? await run()
        : await direct(source === "operator" ? "profiled" : "unprofiled", assertCurrent);
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
    const { params, operatorAuthority: authority, profile, direct } = restrictedSelection();
    params.request.model = "primary";
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
        : await direct(source === "direct-tool" ? "profiled" : "unbound");

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
