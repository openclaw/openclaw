import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { applySessionModelSelection } from "../plugin-sdk/model-session-runtime.js";
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
const { createFixtureParams } = createModelSelectionInputs();

function restrictedSelection(options: { empty?: boolean; assertCurrent?: () => void } = {}) {
  const params = createFixtureParams(
    ["primary", "fallback", "manual"].map((id) => ({ provider: "fixture", id, name: id })),
    {
      model: { primary: "fixture/primary", fallbacks: ["fixture/fallback"] },
      modelPolicy: { allow: ["fixture/primary", "fixture/manual"] },
    },
  );
  const before = structuredClone(params.sessionEntry);
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
    expectUnchanged: () => {
      expect(params.sessionEntry).toEqual(before);
      expectNoSelectionEffects();
    },
    run(
      kind: "caller" | "profiled" | "unprofiled" | "unbound" | "request" = "caller",
      assertCurrent?: () => void,
    ) {
      const run = () => applySessionModelSelection(params);
      if (kind === "caller") {
        return withGatewayToolCallerIdentity(
          { agentId: params.agentId, sessionKey: params.sessionKey, operatorAuthority },
          run,
        );
      }
      if (kind === "request") {
        return withPluginRuntimeGatewayRequestScope(
          {
            client: createSyntheticPluginRuntimeClient({
              authenticatedUserProfile: profile,
              operatorRunAuthority: operatorAuthority,
              scopes: ["operator.write"],
            }),
            isWebchatConnect: () => false,
          },
          run,
        );
      }
      return withOperatorToolGatewayAuthority(
        {
          scopes: ["operator.write"],
          assertCurrent,
          ...(kind !== "unprofiled" ? { authenticatedUserProfile: profile } : {}),
          ...(kind === "profiled" ? { operatorRunAuthority: operatorAuthority } : {}),
        },
        run,
      );
    },
  };
}

it.each([
  ["fallback", false, false, false],
  ["fallback", true, false, true],
  ["primary", false, false, false],
  ["primary", true, true, false],
] as const)(
  "enforces operator policy for %s (reset=%s, empty=%s)",
  async (model, reset, empty, applied) => {
    const { params, run, expectUnchanged } = restrictedSelection({ empty });
    params.request.model = model;
    if (reset) {
      params.request.resetToDefault = true;
    }
    const result = await run();
    if (applied) {
      expect(result).toMatchObject({ status: "applied", provider: "fixture", model: "fallback" });
      expect(params.sessionEntry.modelOverride).toBeUndefined();
    } else {
      expect(result).toMatchObject({ status: "rejected", reason: "not-allowed" });
      expectUnchanged();
      if (model === "primary") {
        expect(result).toMatchObject({ message: expect.stringContaining("operator role") });
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
    const { params, operatorAuthority, run, expectUnchanged } = restrictedSelection(
      source === "caller" ? { assertCurrent } : {},
    );
    params.request.runtime = { kind: "set", runtime: "openclaw" };
    params.request.model = source === "unprofiled" ? "primary" : "manual";
    prepareRuntime.mockImplementationOnce(async () => {
      current = source === "unprofiled";
      return { kind: "ready", runtimeId: "openclaw", validate: () => undefined };
    });
    const result = await run(source === "operator" ? "profiled" : source, assertCurrent);
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
      expectUnchanged();
    }
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  },
);

it.each(["request", "direct-tool", "unbound-operator"] as const)(
  "the public SDK cannot omit operator model policy in %s context",
  async (source) => {
    const { params, run, expectUnchanged } = restrictedSelection();
    params.request.model = "primary";
    const result = await run(
      source === "direct-tool" ? "profiled" : source === "request" ? "request" : "unbound",
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
    expectUnchanged();
  },
);
