import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
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
const { prepareRuntime } = selectionMocks;
const { expectNoSelectionEffects } = useSelectionEffects();
const { createFixtureParams } = createModelSelectionInputs();
const profile = { profileId: "limited", displayName: "Test", hasAvatar: false, updatedAt: 1 };

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
    profileId: profile.profileId,
    scopes: ["operator.write"],
    assertCurrent: options.assertCurrent ?? (() => {}),
    modelPolicy: prepareOperatorModelPolicy({
      cfg: params.cfg,
      policy: { allow: options.empty ? [] : ["fixture/fallback", "fixture/manual"] },
    }),
  });
  return {
    params,
    expectUnchanged: () => {
      expect(params.sessionEntry).toEqual(before);
      expectNoSelectionEffects();
    },
    run: (
      kind: "caller" | "profiled" | "unprofiled" | "unbound" | "request" = "caller",
      assertCurrent?: () => void,
    ) => {
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
  ["caller", "fallback", false, false, false],
  ["caller", "fallback", true, false, true],
  ["caller", "primary", false, false, false],
  ["caller", "primary", true, true, false],
  ["unprofiled", "primary", false, false, true],
] as const)(
  "enforces %s policy for %s (reset=%s, empty=%s)",
  async (source, model, reset, empty, applied) => {
    const { params, run, expectUnchanged } = restrictedSelection({ empty });
    params.request.model = model;
    if (reset) {
      params.request.resetToDefault = true;
    }
    const result = await run(source);
    if (applied) {
      expect(result).toMatchObject({ status: "applied", provider: "fixture", model });
      expect(params.sessionEntry.modelOverride).toBeUndefined();
    } else {
      expect(result).toMatchObject({ status: "rejected", reason: "not-allowed" });
      expectUnchanged();
    }
  },
);

it.each(["caller", "profiled"] as const)(
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
    const { params, run, expectUnchanged } = restrictedSelection(
      source === "caller" ? { assertCurrent } : {},
    );
    params.request.runtime = { kind: "set", runtime: "openclaw" };
    prepareRuntime.mockImplementationOnce(async () => {
      current = false;
      return { kind: "ready", runtimeId: "openclaw", validate: () => undefined };
    });
    const result = await run(source, assertCurrent);
    expect(result).toMatchObject({ status: "rejected", reason: "not-allowed", message });
    expectUnchanged();
  },
);

it.each(["request", "profiled", "unbound"] as const)(
  "the public SDK cannot omit operator model policy in %s context",
  async (source) => {
    const { params, run, expectUnchanged } = restrictedSelection();
    params.request.model = "primary";
    const result = await run(source);

    expect(result).toMatchObject({
      status: "rejected",
      reason: "not-allowed",
      message: expect.stringContaining(
        source === "unbound"
          ? "requires original Gateway authority"
          : "operator role cannot use this model",
      ),
    });
    expectUnchanged();
  },
);
