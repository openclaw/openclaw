import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { raceWithAbortSignal } from "../agents/agent-tools.abort.js";
import { resolveCliRuntimeCanonicalProvider } from "../agents/cli-backends.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { resolveAgentHarnessSelectionDecision } from "../agents/harness/selection-decision.js";
import { requestNativeRuntimeConsent } from "../agents/harness/setup-consent.js";
import { hasRememberedNativeRuntimeConsent } from "../config/native-runtime-consent.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCache } from "../plugins/plugin-cache.js";
import { withPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshotAsync } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  type ActivateSetupInferenceDeps,
  type StageContext,
  type StagedCandidate,
  parseInferenceRef,
  throwIfSetupInferenceCancelled,
  SETUP_INFERENCE_TEST_TIMEOUT_MS,
  SetupInferenceOwnerDriftError,
} from "./setup-inference-core.js";
import { loadSetupInferencePluginGeneration } from "./setup-inference-turn.js";
import type { SetupInferencePluginGeneration } from "./setup-inference-turn.js";
import {
  captureSystemAgentOwnerPluginArtifacts,
  type SystemAgentOwnerPluginArtifactSnapshot,
} from "./verified-inference.js";

export type SetupHarnessVerification = {
  ok: true;
  latencyMs: number;
  binding: SystemAgentOwnerPluginArtifactSnapshot;
};

/** Use the prepared runtime's declaration before verification or activation can run it. */
export async function prepareSetupNativeRuntimeConsent(
  ctx: StageContext,
  staged: StagedCandidate,
  cache: PluginCache,
): Promise<{ config: OpenClawConfig; generation?: SetupInferencePluginGeneration }> {
  const { config, agentRuntimeId: runtime } = staged;
  if (
    !ctx.params.prompter ||
    !runtime ||
    runtime === "openclaw" ||
    runtime === "auto" ||
    hasRememberedNativeRuntimeConsent(config, ctx.routeAgentId, runtime) ||
    resolveCliRuntimeCanonicalProvider({ runtime, config, includeSetupRegistry: true })
  ) {
    return { config };
  }
  throwIfSetupInferenceCancelled(ctx.params);
  const ref = parseInferenceRef(staged.modelRef);
  const generation = await loadSetupInferencePluginGeneration({
    cache,
    config,
    workspaceDir: ctx.workspace,
    selection: {
      provider: ref.provider,
      modelId: ref.model,
      runtime,
      agentId: ctx.routeAgentId,
    },
    pendingPluginInstalls: staged.pendingPluginInstalls,
  });
  throwIfSetupInferenceCancelled(ctx.params);
  const consented = await withPluginRuntimeGenerationScope(generation, async () => {
    const harness = getRegisteredAgentHarness(runtime)?.harness;
    if (!harness) {
      throw new Error(`The ${runtime} runtime is not available for setup.`);
    }
    return requestNativeRuntimeConsent({
      config,
      agentId: ctx.routeAgentId,
      harness,
      prompter: ctx.params.prompter,
      assertCurrent: () => {
        throwIfSetupInferenceCancelled(ctx.params);
        if (getRegisteredAgentHarness(runtime)?.harness !== harness) {
          throw new SetupInferenceOwnerDriftError("The runtime changed during permission setup.");
        }
      },
    });
  });
  return { config: consented, generation };
}

/** Retain the consent generation while projecting the verified candidate's metadata. */
export async function prepareSetupVerificationGeneration(
  ctx: StageContext,
  staged: StagedCandidate,
  candidate: OpenClawConfig,
  cache: PluginCache,
  preparedGeneration?: SetupInferencePluginGeneration,
): Promise<{ generation?: SetupInferencePluginGeneration; metadata: PluginMetadataSnapshot }> {
  const { params, routeAgentId } = ctx;
  const generation = preparedGeneration
    ? {
        ...preparedGeneration,
        config: candidate,
        metadataSnapshot: await withPluginCache(cache, () =>
          resolvePluginMetadataSnapshotAsync({
            config: candidate,
            workspaceDir: ctx.workspace,
            env: process.env,
            index: preparedGeneration.metadataSnapshot.index,
            allowCurrent: false,
          }),
        ),
      }
    : staged.pendingPluginInstalls && Object.keys(staged.pendingPluginInstalls).length > 0
      ? await withPluginLifecycleLease({ signal: params.signal }, async () =>
          loadSetupInferencePluginGeneration({
            cache,
            config: candidate,
            workspaceDir: ctx.workspace,
            selection: {
              provider: parseInferenceRef(staged.modelRef).provider,
              modelId: parseInferenceRef(staged.modelRef).model,
              runtime: staged.agentRuntimeId ?? "openclaw",
              agentId: routeAgentId,
            },
            pendingPluginInstalls: staged.pendingPluginInstalls,
          }),
        )
      : undefined;
  const metadata =
    generation?.metadataSnapshot ??
    (await resolvePluginMetadataSnapshotAsync({
      config: candidate,
      workspaceDir: ctx.workspace,
      env: process.env,
    }));
  return { generation, metadata };
}

export async function verifySetupHarness(params: {
  route: SystemAgentConfiguredRoute;
  deps: ActivateSetupInferenceDeps;
  cache: PluginCache;
  generation?: SetupInferencePluginGeneration;
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
  const generation =
    params.generation ??
    (await loadSetupInferencePluginGeneration({
      cache: params.cache,
      config: route.runConfig,
      workspaceDir,
      selection: {
        provider: route.provider,
        modelId: route.model,
        runtime,
        agentId: route.agentId,
      },
    }));
  params.assertCurrent();
  return await withPluginRuntimeGenerationScope(generation, async () => {
    const registration = getRegisteredAgentHarness(runtime);
    const harness = registration?.harness;
    if (!harness?.verifySetup || harness.authBootstrap !== "harness") {
      return undefined;
    }
    const selection = resolveAgentHarnessSelectionDecision({
      provider: route.provider,
      modelId: route.model,
      config: route.runConfig,
      agentId: route.agentId,
      agentHarnessRuntimeOverride: runtime,
    });
    if (selection.builtIn || selection.harness !== harness) {
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
      });
    const artifacts = capture();
    if (!artifacts.ownerPluginArtifacts.some((entry) => entry.pluginId === ownerPluginId)) {
      throw new Error("The setup verification harness has no trusted runtime artifact.");
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
        ok: true,
        latencyMs: Date.now() - started,
        binding: artifacts,
      } satisfies SetupHarnessVerification;
    } finally {
      open = false;
    }
  });
}
