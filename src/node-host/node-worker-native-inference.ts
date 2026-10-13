import { realpathSync } from "node:fs";
import { resolveConfiguredProviderDefaultApi } from "../agents/embedded-agent-runner/model.configured-overrides.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth-provider-config.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "../agents/model-auth-runtime-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import type { NativeInferenceStartup } from "../worker/native-inference-startup.js";
import {
  NativeRuntimeModelSchema,
  type NativeRuntimeModel,
} from "../worker/native-runtime-config.js";
import { nativeRuntimeModelUnsupportedReason } from "../worker/native-runtime-model-support.js";

type NodeWorkerNativeInferenceModel = {
  model: NativeRuntimeModel;
  credential: string;
};

/** Node-owned canonical model snapshot retained outside every worker child. */
export type NodeWorkerNativeInferenceSnapshot = {
  models: ReadonlyMap<string, NodeWorkerNativeInferenceModel>;
};

export const NODE_WORKER_INFERENCE_SETUP_ERROR =
  "Worker-local inference is not configured on this node. Add a compatible model under " +
  "models.providers with a usable credential in the node openclaw.json, set " +
  'nodeHost.workerRuns.isolation to "none", then restart the node host.';

/** Capture worker-compatible models and their already-resolved node-local credentials. */
export function snapshotNodeWorkerNativeInference(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeWorkerNativeInferenceSnapshot | undefined {
  if (platform === "win32") {
    return undefined;
  }
  const models = new Map<string, NodeWorkerNativeInferenceModel>();
  for (const [providerId, provider] of Object.entries(config.models?.providers ?? {})) {
    const credential =
      resolveManagedSecretRefRuntimeProviderAuth({ cfg: config, provider: providerId })?.apiKey ??
      resolveUsableCustomProviderApiKey({ cfg: config, provider: providerId, env })?.apiKey;
    if (!credential?.trim()) {
      continue;
    }
    const providerApi =
      provider.api ??
      resolveConfiguredProviderDefaultApi({
        provider: providerId,
        providerConfig: provider,
        cfg: config,
      });
    for (const configured of provider.models ?? []) {
      const headers = { ...provider.headers, ...configured.headers };
      const parsed = NativeRuntimeModelSchema.safeParse({
        provider: providerId,
        id: configured.id,
        api: configured.api ?? providerApi,
        baseUrl: configured.baseUrl ?? provider.baseUrl,
        name: configured.name,
        contextWindow: configured.contextWindow,
        maxTokens: configured.maxTokens ?? provider.maxTokens,
        reasoning: configured.reasoning,
        thinkingLevelMap: configured.thinkingLevelMap,
        cost: {
          input: configured.cost?.input ?? 0,
          output: configured.cost?.output ?? 0,
          cacheRead: configured.cost?.cacheRead ?? 0,
          cacheWrite: configured.cost?.cacheWrite ?? 0,
        },
        input: configured.input ?? ["text"],
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
      if (!parsed.success) {
        continue;
      }
      if (nativeRuntimeModelUnsupportedReason(parsed.data.api, credential)) {
        continue;
      }
      models.set(`${parsed.data.provider}/${parsed.data.id}`, {
        model: parsed.data,
        credential,
      });
    }
  }
  return models.size > 0 ? { models } : undefined;
}

export function resolveNodeWorkerNativeInferenceWorkspace(
  snapshot: NodeWorkerNativeInferenceSnapshot | undefined,
  descriptor: WorkerLaunchDescriptor,
): string {
  if (!snapshot) {
    throw new Error(NODE_WORKER_INFERENCE_SETUP_ERROR);
  }
  const ref = `${descriptor.assignment.modelRef.provider}/${descriptor.assignment.modelRef.model}`;
  if (!snapshot.models.has(ref)) {
    throw new Error(
      `Worker-local inference model ${ref} is unavailable on this node. Configure it under ` +
        "models.providers with a usable credential in the node openclaw.json, then restart " +
        "the node host.",
    );
  }
  return realpathSync(descriptor.assignment.workspaceDir);
}

/** Project the node's configured models and one exact managed workspace into a child. */
export function projectNodeWorkerNativeInference(
  snapshot: NodeWorkerNativeInferenceSnapshot,
  descriptor: WorkerLaunchDescriptor,
): NativeInferenceStartup {
  const workspace = resolveNodeWorkerNativeInferenceWorkspace(snapshot, descriptor);
  return {
    config: {
      models: [...snapshot.models.values()].map(({ model }) => structuredClone(model)),
      workspace,
    },
    credentials: Object.fromEntries(
      [...snapshot.models.entries()].map(([modelRef, { credential }]) => [modelRef, credential]),
    ),
  };
}
