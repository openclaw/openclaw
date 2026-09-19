import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import {
  resolvePersistentApplyInference,
  verifySetupInference,
  type ResolvePersistentApplyInferenceDeps,
} from "./setup-inference-turn.js";
import { installSystemAgentClaudeCliBackendTestFixture } from "./system-agent.test-helpers.js";
import { createSystemAgentVerifiedInferenceBinding } from "./verified-inference.js";
import {
  cliRuntimeArtifactAuth,
  cliRuntimeArtifactDeps,
  pluginArtifactDeps,
} from "./verified-inference.test-support.js";

let restoreCliBackend: () => void;
beforeAll(() => {
  restoreCliBackend = installSystemAgentClaudeCliBackendTestFixture();
});
afterAll(() => restoreCliBackend());
const runtime: RuntimeEnv = {
  log() {},
  error() {},
  exit() {
    throw new Error("unexpected exit");
  },
};

it("reprobes the same configured fallback for an opaque owner at persistent apply", async () => {
  await withOpenClawTestState({ label: "opaque-configured-fallback" }, async (state) => {
    const fallbackModelRef = "claude-cli/claude-opus-5";
    const config: OpenClawConfig = {
      agents: {
        entries: {
          ops: {
            default: true,
            model: { primary: "fixture-primary/first", fallbacks: [fallbackModelRef] },
          },
        },
      },
    };
    await state.writeConfig(config);
    const readSnapshot = () =>
      readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
    const snapshot = await readSnapshot();
    expect(snapshot.valid).toBe(true);
    const route = await resolveSystemAgentConfiguredRouteFromConfig(snapshot.config, "ops", {
      fallbackModelRef,
    });
    if (!route || route.runner !== "cli") {
      throw new Error("missing configured CLI fallback");
    }
    const auth = {
      runtimeOwnerFingerprint: "opaque-fallback-owner",
      runtimeOwnerKind: "cli-runtime" as const,
      runtimeOwnerId: "claude-cli",
      ...cliRuntimeArtifactAuth,
    };
    const deps = {
      readConfigFileSnapshot: readSnapshot,
      ...pluginArtifactDeps(),
      ...cliRuntimeArtifactDeps(),
      resolveCliRuntimeOwnerFingerprint: async () => auth.runtimeOwnerFingerprint,
    };
    const binding = await createSystemAgentVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth,
      deps,
    });
    const verifyBoundInference = vi.fn<
      NonNullable<ResolvePersistentApplyInferenceDeps["verifyBoundInference"]>
    >(async (params) => {
      expect(params).toMatchObject({ agentId: "ops", fallbackModelRef });
      return await verifySetupInference({
        ...params,
        bindSession: true,
        deps: {
          ...deps,
          runCliAgent: async (input) => {
            expect(input).toMatchObject({ provider: "claude-cli", model: "claude-opus-5" });
            input.onSuccessfulAuthBinding?.(auth);
            return {
              meta: {
                durationMs: 1,
                finalAssistantVisibleText: "OK",
                executionTrace: { winnerProvider: "claude-cli", winnerModel: "claude-opus-5" },
              },
            };
          },
        },
      });
    });
    await expect(
      resolvePersistentApplyInference({
        binding,
        runtime,
        deps: { ...deps, verifyBoundInference },
      }),
    ).resolves.toBe(binding.execution);
    expect(verifyBoundInference).toHaveBeenCalledOnce();
  });
});
