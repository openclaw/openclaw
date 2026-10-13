import { isAnthropicOAuthApiKey } from "@openclaw/ai/internal/anthropic";
import type { WorkerInferenceModelRef } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import {
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import { resolveModelCatalogIdentityKey } from "../../agents/openai-model-routes.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { projectProviderModelRouteConfig } from "../../agents/provider-model-route.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { prepareSimpleCompletionModel } from "../../agents/simple-completion-runtime.js";
import { resolveTranscriptPolicy } from "../../agents/transcript-policy.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveProviderModelRoutes } from "../../plugins/provider-model-routes.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";

type ResolveApprovedWorkerModelParams = {
  target: BoundAgentRunSessionTarget & { sessionEntry?: SessionEntry };
  modelRef: WorkerInferenceModelRef;
  signal?: AbortSignal;
  runtimeSnapshot: PreparedModelRuntimeSnapshot;
  assertCurrent: () => void;
};

async function resolveApprovedWorkerModelSelection(params: ResolveApprovedWorkerModelParams) {
  const { target, modelRef, runtimeSnapshot } = params;
  const sessionEntry =
    target.sessionEntry ?? (await readSessionEntryInWorker(target, params.assertCurrent));
  if (sessionEntry?.sessionId !== target.sessionId) {
    return undefined;
  }
  params.assertCurrent();
  const lifecycleConfig = runtimeSnapshot.config;
  const agentDir = runtimeSnapshot.agentDir;
  const workspaceDir =
    runtimeSnapshot.workspaceDir ?? resolveAgentWorkspaceDir(lifecycleConfig, target.agentId);
  const selection = {
    cfg: lifecycleConfig,
    agentId: target.agentId,
    manifestPlugins: runtimeSnapshot.metadataSnapshot,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
  };
  const defaultModel = resolveDefaultModelForAgent(selection);
  const policy = createModelVisibilityPolicy({
    ...selection,
    catalog: runtimeSnapshot.modelCatalog.entries,
    defaultProvider: defaultModel.provider,
    defaultModel,
  });
  const resolved = resolveModelRefFromString({
    ...selection,
    raw: `${modelRef.provider}/${modelRef.model}`,
    defaultProvider: defaultModel.provider,
    aliasIndex: policy.selectionAliasIndex,
  });
  if (
    !resolved ||
    normalizeProviderId(resolved.ref.provider) !== normalizeProviderId(modelRef.provider)
  ) {
    return undefined;
  }
  const resolvedKey = resolveModelCatalogIdentityKey({
    provider: resolved.ref.provider,
    id: resolved.ref.model,
  });
  const known =
    policy.allowedCatalog.some((entry) => resolvedKey === resolveModelCatalogIdentityKey(entry)) ||
    policy.retainedKeys.has(resolvedKey);
  if (!known || !policy.allows(resolved.ref)) {
    return undefined;
  }
  const harnessPolicy = resolveAgentHarnessPolicy({
    provider: resolved.ref.provider,
    modelId: resolved.ref.model,
    config: lifecycleConfig,
    agentId: target.agentId,
    sessionKey: target.sessionKey,
  });
  return { sessionEntry, lifecycleConfig, agentDir, workspaceDir, resolved, harnessPolicy };
}

export async function resolveApprovedWorkerLocalModel(params: ResolveApprovedWorkerModelParams) {
  const { runtimeSnapshot } = params;
  return await withPluginRuntimeGenerationScope(runtimeSnapshot, async () => {
    const approved = await resolveApprovedWorkerModelSelection(params);
    if (!approved) {
      return undefined;
    }
    const { lifecycleConfig, workspaceDir, resolved } = approved;
    const model = runtimeSnapshot.findConfiguredRuntimeModel(
      resolved.ref.provider,
      resolved.ref.model,
    );
    if (!model) {
      return {
        error:
          `Worker-local inference model ${resolved.ref.provider}/${resolved.ref.model} is missing ` +
          "from the Gateway model catalog. Add its metadata under models.providers in the " +
          "Gateway openclaw.json; keep its endpoint and credentials only on the node.",
      };
    }
    return {
      transcriptPolicy: resolveTranscriptPolicy({
        provider: resolved.ref.provider,
        modelId: resolved.ref.model,
        modelApi: model.api,
        model,
        config: lifecycleConfig,
        workspaceDir,
        directApiKey: false,
      }),
      model,
    };
  });
}

export async function resolveApprovedWorkerModel(params: ResolveApprovedWorkerModelParams) {
  const { target, signal, runtimeSnapshot, modelRef } = params;
  return await withPluginRuntimeGenerationScope(runtimeSnapshot, async () => {
    const approved = await resolveApprovedWorkerModelSelection(params);
    if (!approved) {
      return undefined;
    }
    const { sessionEntry, lifecycleConfig, agentDir, workspaceDir, resolved, harnessPolicy } =
      approved;
    const agentRuntimeId =
      harnessPolicy.runtimeSource !== "implicit" ||
      lifecycleConfig.plugins?.entries?.codex?.enabled === true
        ? harnessPolicy.runtime
        : undefined;
    const sessionSelection = await resolveSessionAuthSelection({
      cfg: lifecycleConfig,
      provider: resolved.ref.provider,
      modelId: resolved.ref.model,
      agentId: target.agentId,
      harnessRuntime: harnessPolicy.runtime,
      agentDir,
      sessionEntry,
      sessionStore: { [target.sessionKey]: sessionEntry },
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      assertCommitAllowed: params.assertCurrent,
      isNewSession: false,
    });
    params.assertCurrent();
    const selectedProfileId = sessionSelection?.profileId;
    const routeRequirement = sessionSelection?.routeRequirement;
    let modelConfig = lifecycleConfig;
    const routeResolution = routeRequirement
      ? resolveProviderModelRoutes({
          provider: resolved.ref.provider,
          modelId: resolved.ref.model,
          config: lifecycleConfig,
        })
      : undefined;
    const route =
      routeResolution?.kind === "routes"
        ? routeResolution.routes.find((candidate) => candidate.authRequirement === routeRequirement)
        : undefined;
    if (route) {
      // Worker placement owns the agent harness, while the gateway-owned profile
      // owns the provider route. Keep those decisions separate or OAuth can be
      // materialized as a public API-key endpoint and fail before the first token.
      modelConfig = projectProviderModelRouteConfig({
        provider: resolved.ref.provider,
        config: lifecycleConfig,
        route,
      });
    }
    // Route projection and credential selection are one decision. Pin even an
    // automatic profile so generic auth fallback cannot cross to another route.
    const prepared = await prepareSimpleCompletionModel({
      // This session-bound worker owner revalidates the exact live turn after awaited work.
      workerInferenceAuthority: { assertCurrent: params.assertCurrent },
      cfg: modelConfig,
      transport: "provider-stream",
      agentId: target.agentId,
      provider: resolved.ref.provider,
      modelId: resolved.ref.model,
      agentDir,
      modelIdSource: "selected",
      ...(selectedProfileId
        ? { profileId: selectedProfileId, preferredProfile: selectedProfileId, bindAuthOwner: true }
        : {}),
      allowMissingApiKeyModes: ["aws-sdk"],
      allowBundledStaticCatalogFallback: true,
      signal,
      preparedModelRuntime: runtimeSnapshot,
      workspaceDir,
      ...(agentRuntimeId ? { agentRuntimeId } : {}),
    });
    params.assertCurrent();
    if ("error" in prepared) {
      return prepared;
    }
    return {
      transcriptPolicy: resolveTranscriptPolicy({
        provider: resolved.ref.provider,
        modelId: resolved.ref.model,
        modelApi: prepared.model.api,
        model: prepared.model,
        config: lifecycleConfig,
        workspaceDir,
        directApiKey:
          Boolean(prepared.auth.apiKey) && !isAnthropicOAuthApiKey(prepared.auth.apiKey),
      }),
      provider: resolved.ref.provider,
      model: resolved.ref.model,
      workspaceDir,
      modelRef,
      runtimeSnapshot,
      sessionEntry,
      prepared,
    };
  });
}

export type PreparedWorkerInference = Extract<
  Awaited<ReturnType<typeof resolveApprovedWorkerModel>>,
  { prepared: unknown }
>;
