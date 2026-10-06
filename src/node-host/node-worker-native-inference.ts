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

function resolvedHeaders(
  providerHeaders: Record<string, unknown> | undefined,
  modelHeaders: Record<string, string> | undefined,
): Record<string, string> | null | undefined {
  const values = { ...providerHeaders, ...modelHeaders };
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") {
      return null;
    }
    resolved[key] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function resolveProviderCredential(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  provider: string;
}): string | undefined {
  return (
    resolveManagedSecretRefRuntimeProviderAuth({
      cfg: params.config,
      provider: params.provider,
    })?.apiKey ??
    resolveUsableCustomProviderApiKey({
      cfg: params.config,
      provider: params.provider,
      env: params.env,
    })?.apiKey
  );
}

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
    const credential = resolveProviderCredential({ config, env, provider: providerId });
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
      const input = configured.input ?? ["text"];
      if (input.some((kind) => kind !== "text" && kind !== "image")) {
        continue;
      }
      const headers = resolvedHeaders(provider.headers, configured.headers);
      if (headers === null) {
        continue;
      }
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
        input,
        headers,
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

/** Project the node's configured models and one exact managed workspace into a child. */
export function projectNodeWorkerNativeInference(
  snapshot: NodeWorkerNativeInferenceSnapshot,
  descriptor: WorkerLaunchDescriptor,
): NativeInferenceStartup {
  const ref = `${descriptor.assignment.modelRef.provider}/${descriptor.assignment.modelRef.model}`;
  const selected = snapshot.models.get(ref);
  if (!selected) {
    throw new Error(`Node worker model ${ref} is not configured for worker inference`);
  }
  return {
    config: {
      models: [...snapshot.models.values()].map(({ model }) => structuredClone(model)),
      workspace: realpathSync(descriptor.assignment.workspaceDir),
    },
    credentials: Object.fromEntries(
      [...snapshot.models.entries()].map(([modelRef, { credential }]) => [modelRef, credential]),
    ),
  };
}

/** Diagnostic scrubbing covers every projected credential and configured header value. */
function nodeWorkerNativeInferenceSecrets(snapshot: NodeWorkerNativeInferenceSnapshot): string[] {
  return [
    ...[...snapshot.models.values()].flatMap(({ model, credential }) => [
      credential,
      ...Object.values(model.headers ?? {}),
    ]),
  ].filter((value) => value.length > 0);
}

export function nodeWorkerNativeInferenceSecretsForDescriptor(
  snapshot: NodeWorkerNativeInferenceSnapshot | undefined,
  descriptor: WorkerLaunchDescriptor,
): string[] {
  return descriptor.assignment.inference === "runtime-local" && snapshot
    ? nodeWorkerNativeInferenceSecrets(snapshot)
    : [];
}

export function assertNodeWorkerNativeInferenceAvailable(
  snapshot: NodeWorkerNativeInferenceSnapshot | undefined,
  descriptor: WorkerLaunchDescriptor,
): void {
  if (descriptor.assignment.inference !== "runtime-local") {
    return;
  }
  if (!snapshot) {
    throw new Error("Node worker native inference requires node-local startup configuration");
  }
  projectNodeWorkerNativeInference(snapshot, descriptor);
}
