import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveModelAsync } from "../agents/embedded-agent-runner/model.js";
import { isMinimaxVlmModel } from "../agents/minimax-vlm.js";
import { requireApiKey } from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.js";
import { acquirePreparedModelRuntimeSnapshotInvocation } from "../agents/prepared-model-runtime.resources.js";
import { prepareSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import type { Model } from "../llm/types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ImageDescriptionRequest } from "./provider-types.js";

type ImageRuntimeParams = Omit<
  ImageDescriptionRequest,
  "buffer" | "fileName" | "mime" | "prompt" | "maxTokens" | "timeoutMs"
>;

type ImageRuntimeResources = AsyncDisposable & {
  run: <T>(run: () => T) => T;
  assertResourcesOpen?: () => void;
};

function bindResolvedImageRuntime(
  params: ImageRuntimeParams,
  apiKey: string,
  model: Model,
  run: ImageRuntimeResources["run"],
) {
  return {
    run,
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
  const supplied = suppliedSnapshot
    ? {
        snapshot: suppliedSnapshot,
        claim: acquirePreparedModelRuntimeSnapshotInvocation(suppliedSnapshot),
      }
    : undefined;
  const suppliedClaim = supplied?.claim;
  const preparedRuntimeLease = supplied
    ? {
        snapshot: supplied.snapshot,
        run: <T>(run: () => T): T => supplied.claim.run(run),
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
  const runPrepared = <T>(run: () => T): T =>
    preparedRuntimeLease.run(() =>
      withPluginRuntimeGenerationScope(preparedRuntimeLease.snapshot, run),
    );
  onAcquired({
    run: runPrepared,
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
  return await runPrepared(async () => {
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
    // A model can have several credential routes, such as the OpenAI Platform API and ChatGPT.
    // The shared completion owner selects the credential first and returns the route it owns.
    const prepared = await prepareSimpleCompletionModel({
      cfg: preparedParams.cfg,
      ...(preparedParams.agentId ? { agentId: preparedParams.agentId } : {}),
      provider: model.provider,
      modelId: model.id,
      modelIdSource: "selected",
      agentDir: preparedParams.agentDir,
      profileId: preparedParams.profile,
      preferredProfile: preparedParams.preferredProfile,
      authStore: preparedParams.authStore,
      // Account-scoped limits must come from the account the selected credential belongs to.
      credentialScopedModelMetadata: true,
      // Bedrock's runtime client owns AWS credential-chain resolution.
      allowMissingApiKeyModes: ["aws-sdk"],
      allowBundledStaticCatalogFallback: true,
      skipAgentDiscovery: true,
      transport: "provider-stream",
      preparedModelRuntime: preparedRuntime,
      ...(preparedParams.workspaceDir ? { workspaceDir: preparedParams.workspaceDir } : {}),
      signal: preparedParams.signal,
    });
    preparedParams.signal?.throwIfAborted();
    if (!("model" in prepared)) {
      throw new Error(prepared.error);
    }
    model = requireImageCapableModel({
      model: prepared.model,
      resolvedProvider: model.provider,
      resolvedModel: model.id,
      requestedProvider: preparedParams.provider,
      requestedModel: preparedParams.model,
    });
    const apiKey =
      prepared.auth.mode === "aws-sdk" && model.api === "bedrock-converse-stream"
        ? (prepared.auth.apiKey ?? "")
        : requireApiKey(prepared.auth, model.provider);
    return bindResolvedImageRuntime(preparedParams, apiKey, model, runPrepared);
  });
}
