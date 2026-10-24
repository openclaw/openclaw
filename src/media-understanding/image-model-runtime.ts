import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveModelAsync } from "../agents/embedded-agent-runner/model.js";
import { isMinimaxVlmModel } from "../agents/minimax-vlm.js";
import {
  applySecretRefHeaderSentinels,
  getApiKeyForModelCore,
  requireApiKey,
} from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.js";
import { retainPreparedModelRuntimeSnapshotResources } from "../agents/prepared-model-runtime.resources.js";
import { resolveProviderModelMaterializationAuthMode } from "../agents/provider-model-route-auth.js";
import { applyPreparedRuntimeAuthToModel } from "../agents/provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "../agents/provider-runtime-auth-protection.js";
import { providerUsesCredentialScopedModelMetadata } from "../agents/runtime-plan/credential-scoped-model.js";
import { getModelRegistryRuntime } from "../agents/sessions/model-registry-runtime.js";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import type { Model } from "../llm/types.js";
import {
  attachProviderAuthAuthority,
  getProviderAuthAuthority,
} from "../plugins/provider-auth-authority.js";
import {
  attachModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ImageDescriptionRequest } from "./types.js";

type ImageRuntimeParams = Omit<
  ImageDescriptionRequest,
  "buffer" | "fileName" | "mime" | "prompt" | "maxTokens" | "timeoutMs"
>;

type ImageRuntimeResources = AsyncDisposable & {
  assertResourcesOpen?: () => void;
};

function bindResolvedImageRuntime(params: ImageRuntimeParams, apiKey: string, model: Model) {
  return {
    runtimeValue: apiKey,
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  };
}

function formatModelInputCapabilities(input: Model["input"] | undefined): string {
  return input && input.length > 0 ? input.join(", ") : "none";
}

function requireImageCapableModel(params: {
  model: Model | undefined;
  resolvedProvider: string;
  resolvedModel: string;
  requestedProvider: string;
  requestedModel: string;
}): Model {
  if (!params.model) {
    throw new Error(`Unknown model: ${params.resolvedProvider}/${params.resolvedModel}`);
  }
  if (params.model.input?.includes("image")) {
    return params.model;
  }
  // Keep MiniMax's unknown-model signal so its dedicated VLM fallback remains reachable.
  if (isMinimaxVlmModel(params.resolvedProvider, params.resolvedModel)) {
    throw new Error(`Unknown model: ${params.resolvedProvider}/${params.resolvedModel}`);
  }
  throw new Error(
    `Model does not support images: ${params.requestedProvider}/${params.requestedModel} ` +
      `(resolved ${params.model.provider}/${params.model.id} input: ${formatModelInputCapabilities(params.model.input)})`,
  );
}

export async function resolveImageRuntime(
  params: ImageRuntimeParams,
  onAcquired: (resources: ImageRuntimeResources) => void,
) {
  const workspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg ?? {}, params.agentId) : undefined);
  const runtimeParams = workspaceDir ? { ...params, workspaceDir } : params;
  const authProfileOptions = {
    ...(params.profile ? { authProfileId: params.profile } : {}),
    ...(params.preferredProfile ? { preferredProfile: params.preferredProfile } : {}),
  };
  const suppliedSnapshot = params.preparedModelRuntime as PreparedModelRuntimeSnapshot | undefined;
  let resolvedRef = suppliedSnapshot
    ? normalizeModelRef(params.provider, params.model, {
        manifestPlugins: suppliedSnapshot.metadataSnapshot,
      })
    : { provider: params.provider, model: params.model };
  const suppliedClaim = suppliedSnapshot
    ? retainPreparedModelRuntimeSnapshotResources(suppliedSnapshot)
    : undefined;
  const preparedRuntimeLease = suppliedSnapshot
    ? {
        snapshot: suppliedSnapshot,
        async [Symbol.asyncDispose]() {
          await suppliedClaim?.release();
        },
      }
    : await acquireAgentRunPreparedModelRuntime(
        {
          agentDir: params.agentDir,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          config: params.cfg ?? {},
          ...(runtimeParams.workspaceDir ? { workspaceDir: runtimeParams.workspaceDir } : {}),
          loadRuntimePlugins: true,
          runtimePluginPurpose: "isolated-completion",
        },
        // The request already chose a model; full inventory discovery must stay outside setup.
        {
          catalogMode: "static",
          abortSignal: params.signal,
          deriveRuntimePluginSelections: ({ metadataSnapshot }) => {
            resolvedRef = normalizeModelRef(params.provider, params.model, {
              manifestPlugins: metadataSnapshot,
            });
            return [
              {
                provider: resolvedRef.provider,
                modelId: resolvedRef.model,
                ...(params.agentId ? { agentId: params.agentId } : {}),
              },
            ];
          },
        },
      );
  // The operation owns release before setup can leave asynchronous cleanup behind.
  onAcquired({
    [Symbol.asyncDispose]: () => preparedRuntimeLease[Symbol.asyncDispose](),
    ...(suppliedClaim ? { assertResourcesOpen: suppliedClaim.assertOpen } : {}),
  });
  params.signal?.throwIfAborted();
  const preparedRuntime = preparedRuntimeLease.snapshot;
  const preparedWorkspaceDir = preparedRuntime.workspaceDir ?? runtimeParams.workspaceDir;
  const preparedParams: ImageRuntimeParams = {
    ...runtimeParams,
    agentDir: preparedRuntime.agentDir,
    cfg: preparedRuntime.config,
    preparedModelRuntime: preparedRuntime,
    ...(preparedWorkspaceDir ? { workspaceDir: preparedWorkspaceDir } : {}),
  };
  // Media request types carry this agent-owned handle opaquely to avoid importing the agent
  // runtime graph into provider contracts. This is the sole boundary that consumes its stores.
  const preparedStores = preparedRuntime.createStores() as Required<
    Pick<NonNullable<Parameters<typeof resolveModelAsync>[4]>, "authStorage" | "modelRegistry">
  >;
  const resolveOptions = {
    abortSignal: params.signal,
    modelIdSource: "selected" as const,
    allowBundledStaticCatalogFallback: true,
    ...preparedStores,
    preparedModelRuntime: preparedRuntime,
    skipAgentDiscovery: true,
    ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
    ...authProfileOptions,
  };
  return await withPluginRuntimeGenerationScope(preparedRuntime, async () => {
    const resolved = await resolveModelAsync(
      resolvedRef.provider,
      resolvedRef.model,
      preparedParams.agentDir,
      preparedParams.cfg,
      resolveOptions,
    );
    // Setup may have closed during model lookup; do not start auth for a late result.
    params.signal?.throwIfAborted();
    let model = requireImageCapableModel({
      model: resolved.model,
      resolvedProvider: resolvedRef.provider,
      resolvedModel: resolvedRef.model,
      requestedProvider: params.provider,
      requestedModel: params.model,
    });
    const { authStorage, modelRegistry } = resolved;
    const modelRuntime = getModelRegistryRuntime(modelRegistry);
    const bindPreparedModel = (candidate: Model): Model => {
      const requestModel = applySecretRefHeaderSentinels(candidate, preparedParams.cfg);
      const providerRuntimeHandle = resolveProviderRuntimePluginHandle({
        provider: requestModel.provider,
        modelId: requestModel.id,
        config: preparedParams.cfg,
        workspaceDir: preparedParams.workspaceDir,
        env: process.env,
        pluginMetadataSnapshot: preparedRuntime.metadataSnapshot,
      });
      return bindModelLlmRuntime(
        attachModelProviderRuntimePluginHandle(requestModel, providerRuntimeHandle),
        modelRuntime.llmRuntime,
      );
    };
    const apiKeyInfo = await getApiKeyForModelCore({
      model,
      cfg: preparedParams.cfg,
      agentDir: preparedParams.agentDir,
      ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
      profileId: preparedParams.profile,
      preferredProfile: preparedParams.preferredProfile,
      store: preparedParams.authStore,
      secretSentinels: true,
    });
    preparedParams.signal?.throwIfAborted();
    if (
      providerUsesCredentialScopedModelMetadata({
        provider: model.provider,
        modelId: model.id,
        config: preparedParams.cfg,
        agentDir: preparedParams.agentDir,
        workspaceDir: preparedParams.workspaceDir,
      })
    ) {
      const authProfileMode = resolveProviderModelMaterializationAuthMode(apiKeyInfo.mode);
      const authoritative = await resolveModelAsync(
        model.provider,
        model.id,
        preparedParams.agentDir,
        preparedParams.cfg,
        {
          abortSignal: preparedParams.signal,
          modelIdSource: "selected",
          authStorage,
          modelRegistry,
          skipAgentDiscovery: true,
          allowBundledStaticCatalogFallback: true,
          preparedModelRuntime: preparedParams.preparedModelRuntime as PreparedModelRuntimeSnapshot,
          ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
          ...(apiKeyInfo.profileId
            ? { authProfileId: apiKeyInfo.profileId }
            : authProfileMode
              ? { authProfileMode }
              : {}),
        },
      );
      preparedParams.signal?.throwIfAborted();
      model = requireImageCapableModel({
        model: authoritative.model,
        resolvedProvider: model.provider,
        resolvedModel: model.id,
        requestedProvider: preparedParams.provider,
        requestedModel: preparedParams.model,
      });
    }
    // Bedrock's runtime client owns AWS credential-chain resolution. Keep the
    // empty sentinel out of auth storage and pass it through to the stream.
    if (
      !apiKeyInfo.apiKey?.trim() &&
      apiKeyInfo.mode === "aws-sdk" &&
      model.api === "bedrock-converse-stream"
    ) {
      return bindResolvedImageRuntime(preparedParams, "", bindPreparedModel(model));
    }
    model = attachProviderAuthAuthority(model, getProviderAuthAuthority(apiKeyInfo));
    let apiKey = requireApiKey(apiKeyInfo, model.provider);
    const runtimeAuth = await prepareProviderRuntimeAuth({
      provider: model.provider,
      config: preparedParams.cfg,
      workspaceDir: preparedParams.workspaceDir,
      env: process.env,
      context: {
        config: preparedParams.cfg,
        workspaceDir: preparedParams.workspaceDir,
        env: process.env,
        provider: model.provider,
        modelId: model.id,
        model,
        apiKey,
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
      },
    });
    preparedParams.signal?.throwIfAborted();
    const preparedAuth = protectPreparedProviderRuntimeAuth({
      provider: model.provider,
      preparedAuth: runtimeAuth,
    });
    apiKey = preparedAuth?.apiKey?.trim() || apiKey;
    model = applyPreparedRuntimeAuthToModel(model, preparedAuth);
    authStorage.setRuntimeApiKey(model.provider, apiKey);
    return bindResolvedImageRuntime(preparedParams, apiKey, bindPreparedModel(model));
  });
}
