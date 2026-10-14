import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { raceWithAbortSignal } from "../agents/agent-tools.abort.js";
import { fingerprintOpaqueRuntimeOwner } from "../agents/execution-auth-binding.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import type { PluginCache } from "../plugins/plugin-cache.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  type ActivateSetupInferenceDeps,
  SETUP_INFERENCE_TEST_TIMEOUT_MS,
  SetupInferenceOwnerDriftError,
} from "./setup-inference-core.js";
import { loadSetupInferencePluginGeneration } from "./setup-inference-turn.js";
import {
  captureSystemAgentOwnerPluginArtifacts,
  type SystemAgentOwnerPluginArtifactSnapshot,
} from "./verified-inference.js";

/** Native readiness, deliberately distinct from proof that an inference turn executed. */
export type SetupHarnessVerification = {
  kind: "harness-setup";
  latencyMs: number;
  binding: SystemAgentOwnerPluginArtifactSnapshot & {
    runtimeOwnerId: string;
    runtimeOwnerFingerprint: string;
    runtimeArtifactId: string;
    runtimeArtifactFingerprint: string;
  };
};

/** Optional setup-only path; absent hooks and credential-backed routes retain the turn probe. */
export async function verifySetupHarness(params: {
  route: SystemAgentConfiguredRoute;
  deps: ActivateSetupInferenceDeps;
  cache: PluginCache;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<SetupHarnessVerification | undefined> {
  const { route, deps } = params;
  const runtime = route.runner === "embedded" ? route.agentHarnessRuntimeOverride : undefined;
  if (route.authProfileId || !runtime || runtime === "openclaw" || runtime === "auto") {
    return undefined;
  }
  params.assertCurrent();
  const workspaceDir = resolveAgentWorkspaceDir(route.runConfig, route.agentId, process.env);
  const generation = await loadSetupInferencePluginGeneration({
    cache: params.cache,
    config: route.runConfig,
    workspaceDir,
    selection: { provider: route.provider, modelId: route.model, runtime, agentId: route.agentId },
    resolvePluginMetadataSnapshot: deps.resolvePluginMetadataSnapshot,
  });
  params.assertCurrent();
  return await withPluginRuntimeGenerationScope(generation, async () => {
    const registration = getRegisteredAgentHarness(runtime);
    const harness = registration?.harness;
    if (!harness?.verifySetup || harness.authBootstrap !== "harness") {
      return undefined;
    }
    const verify = harness.verifySetup.bind(harness);
    const ownerPluginId = registration?.ownerPluginId;
    if (!ownerPluginId) {
      throw new Error("The setup verification harness has no plugin owner.");
    }
    const capture = () =>
      (deps.captureSystemAgentOwnerPluginArtifacts ?? captureSystemAgentOwnerPluginArtifacts)({
        config: route.runConfig,
        executionRoute: route,
        deps,
      });
    const artifacts = capture();
    const artifact = artifacts.ownerPluginArtifacts.find(
      (entry) => entry.pluginId === ownerPluginId,
    );
    if (!artifact) {
      throw new Error("The setup verification harness has no trusted runtime artifact.");
    }
    const fingerprint = fingerprintOpaqueRuntimeOwner({
      kind: "plugin-harness",
      runner: "embedded",
      provider: route.provider,
      backendId: runtime,
      runtimeArtifactFingerprint: artifact.fingerprint,
    });
    if (!fingerprint) {
      throw new Error("The setup verification harness owner could not be bound.");
    }
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS);
    const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
    let open = true;
    const assertCurrent = () => {
      if (!open) {
        throw new Error("The setup verification operation has closed.");
      }
      signal.throwIfAborted();
      params.assertCurrent();
      if (getRegisteredAgentHarness(runtime)?.harness !== harness) {
        throw new SetupInferenceOwnerDriftError("The setup verification harness changed.");
      }
    };
    const started = Date.now();
    try {
      assertCurrent();
      await raceWithAbortSignal(
        verify({
          config: route.runConfig,
          provider: route.provider,
          modelId: route.model,
          workspaceDir,
          signal,
          assertCurrent,
        }),
        signal,
      );
      assertCurrent();
      if (!isDeepStrictEqual(artifacts, capture())) {
        throw new SetupInferenceOwnerDriftError(
          "The setup verification plugin changed during its check.",
        );
      }
      return {
        kind: "harness-setup" as const,
        latencyMs: Date.now() - started,
        binding: {
          ...artifacts,
          runtimeOwnerId: runtime,
          runtimeOwnerFingerprint: fingerprint,
          runtimeArtifactId: ownerPluginId,
          runtimeArtifactFingerprint: artifact.fingerprint,
        },
      };
    } finally {
      open = false;
    }
  });
}
