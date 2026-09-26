import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  createLlmRuntime,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
} from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { isCredentialFieldName } from "@openclaw/ai/internal/shared";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { z } from "zod";
import { isPathInside } from "../infra/path-guards.js";
import {
  NativeRuntimeConfigSchema,
  NativeRuntimeIdentifier as id,
  type NativeRuntimeConfig,
} from "./native-runtime-config.js";
import { buildNativeRuntimeFetch } from "./native-runtime-transport.js";
const BindingSchema = z.object({ workspaceId: id, workspacePath: z.string().optional() });

type NativeRuntimeTurn = {
  binding: { workspaceId: string; workspacePath?: string };
  selection: { provider: string; modelId: string };
};
export type NativeRuntimeResolved = {
  model: Model;
  streamFn: StreamFn;
  workspacePath: string;
  assertProtocolSafe: (value: unknown) => void;
  hasCredentialPrefix: (value: unknown) => boolean;
};
export type NativeRuntime = {
  withTurn<T>(
    turn: NativeRuntimeTurn,
    callback: (resolved: NativeRuntimeResolved) => Promise<T>,
  ): Promise<T>;
  close(): void;
};

type Workspace = {
  sourcePath: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  models: Set<string>;
  scope?: "exact" | "subdirectories";
};
type RegisteredModel = {
  model: Model;
  apiKeyEnv: string;
  headers: Record<string, string>;
};
const SelectionSchema = z.strictObject({
  provider: NativeRuntimeConfigSchema.shape.models.element.shape.provider,
  modelId: id,
});

async function assertWorkspace(workspace: Workspace): Promise<void> {
  const canonicalPath = await realpath(workspace.sourcePath);
  const current = await stat(canonicalPath);
  if (
    canonicalPath !== workspace.canonicalPath ||
    !current.isDirectory() ||
    current.dev !== workspace.dev ||
    current.ino !== workspace.ino
  ) {
    throw new Error("Native runtime workspace changed since startup");
  }
}

/**
 * Owns provider I/O in the dedicated runtime process. In particular, do not import
 * src/llm/stream: that facade installs Gateway transport policy and auth state.
 */
export async function createNativeRuntime(
  config: NativeRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeRuntime> {
  const parsed = NativeRuntimeConfigSchema.parse(config);
  // The embedded loop can import the Gateway facade. Keep its process policy
  // out of this runtime's provider requests without resetting anyone else's host.
  const runtime = createLlmRuntime(undefined, {
    transportHost: {
      buildModelFetch: buildNativeRuntimeFetch,
      requiresManagedTransport: () => true,
    },
  });
  registerBuiltInApiProviders(runtime.registry);
  const models = new Map<string, RegisteredModel>();
  const workspaces = new Map<string, Workspace>();
  const credentials = new Map<string, string>();

  const protocolSecrets = new Set<string>();
  const addProtocolSecret = (value: string) => {
    protocolSecrets.add(value);
    // HTTP Headers removes surrounding whitespace; guard that effective value too.
    const normalized = value.trim();
    if (normalized) {
      protocolSecrets.add(normalized);
    }
  };

  // Snapshot only explicitly named credentials, before the first asynchronous work.
  for (const entry of parsed.models) {
    if (!credentials.has(entry.apiKeyEnv)) {
      const value = env[entry.apiKeyEnv];
      if (!value?.trim()) {
        throw new Error(
          "Missing native runtime credential environment variable: " + entry.apiKeyEnv,
        );
      }
      credentials.set(entry.apiKeyEnv, value);
      addProtocolSecret(value);
    }
  }
  for (const entry of parsed.models) {
    const ref = entry.provider + "/" + entry.id;
    if (models.has(ref)) {
      throw new Error("Duplicate native runtime model: " + ref);
    }
    if (!runtime.registry.getApiProvider(entry.api)) {
      throw new Error("Unsupported native runtime API: " + entry.api);
    }
    // The maintained Azure simple adapter reads endpoint/deployment overrides
    // from ambient env even with an explicit model. It cannot meet this contract.
    if (entry.api === "azure-openai-responses") {
      throw new Error("Native runtime does not support ambient-configured Azure API adapters");
    }
    const apiKey = credentials.get(entry.apiKeyEnv)!;
    if (
      entry.api === "google-vertex" &&
      (apiKey.trim() === "gcp-vertex-credentials" || /^<[^>]+>$/.test(apiKey.trim()))
    ) {
      throw new Error("Native runtime Vertex requires an explicit API key, not ambient ADC");
    }
    const {
      apiKeyEnv,
      headers: configuredHeaders,
      sensitiveHeaderNames: classifiedHeaders,
      ...definition
    } = entry;
    const headers = Object.fromEntries(
      Object.entries(configuredHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    // The OpenAI SDK otherwise adds ambient organization/project headers. Empty
    // explicit values suppress that fallback without reading those env variables.
    if (entry.api === "openai-completions" || entry.api === "openai-responses") {
      headers["openai-organization"] ??= "";
      headers["openai-project"] ??= "";
    }
    const model: Model = {
      ...definition,
      name: entry.name ?? entry.id,
      reasoning: entry.reasoning ?? false,
      input: entry.input ?? ["text"],
    };
    Object.freeze(model.input);
    Object.freeze(model.cost);
    if (model.thinkingLevelMap) {
      Object.freeze(model.thinkingLevelMap);
    }
    Object.freeze(model);
    const sensitiveHeaderNames = new Set(
      (classifiedHeaders ?? []).map((name) => name.toLowerCase()),
    );
    if ([...sensitiveHeaderNames].some((name) => !Object.hasOwn(headers, name))) {
      throw new Error("Sensitive native header name is not configured");
    }
    models.set(ref, { model, apiKeyEnv, headers: Object.freeze(headers) });
    for (const [name, value] of Object.entries(headers)) {
      if (value && (isCredentialFieldName(name) || sensitiveHeaderNames.has(name))) {
        addProtocolSecret(value);
        if (name === "authorization" || name === "proxy-authorization") {
          const token = /^(?:Bearer|Basic)\s+(\S+)$/iu.exec(value.trim())?.[1];
          if (token) {
            protocolSecrets.add(token);
          }
        }
      }
    }
  }
  for (const entry of parsed.workspaces) {
    if (workspaces.has(entry.id)) {
      throw new Error("Duplicate native runtime workspace: " + entry.id);
    }
    const allowed = new Set(entry.models ?? models.keys());
    for (const ref of allowed) {
      if (!models.has(ref)) {
        throw new Error("Unknown native runtime workspace model: " + ref);
      }
    }
    const sourcePath = path.resolve(entry.path);
    const canonicalPath = await realpath(sourcePath);
    const directory = await stat(canonicalPath);
    if (!directory.isDirectory()) {
      throw new Error("Native runtime workspace must be a directory: " + entry.id);
    }
    workspaces.set(entry.id, {
      sourcePath,
      canonicalPath,
      dev: directory.dev,
      ino: directory.ino,
      models: allowed,
      scope: entry.scope,
    });
  }

  const hasCredentialPrefix = (value: unknown): boolean => {
    if (typeof value === "string") {
      for (const secret of protocolSecrets) {
        for (let size = Math.min(value.length, secret.length - 1); size > 0; size--) {
          if (secret.startsWith(value.slice(-size))) {
            return true;
          }
        }
      }
      return false;
    }
    return (
      value !== null && typeof value === "object" && Object.values(value).some(hasCredentialPrefix)
    );
  };
  let closed = false;
  const activeTurns = new Set<AbortController>();
  function assertOpen() {
    if (closed) {
      throw new Error("Native runtime is closed");
    }
  }
  return {
    async withTurn<T>(
      turn: NativeRuntimeTurn,
      callback: (resolved: NativeRuntimeResolved) => Promise<T>,
    ) {
      assertOpen();
      const binding = BindingSchema.parse(turn.binding);
      const selection = SelectionSchema.parse(turn.selection);
      const ref = selection.provider + "/" + selection.modelId;
      const workspace = workspaces.get(binding.workspaceId);
      const registered = models.get(ref);
      if (!workspace || !registered || !workspace.models.has(ref)) {
        throw new Error("Native runtime workspace/model selection is not allowed");
      }
      await assertWorkspace(workspace);
      const workspacePath = binding.workspacePath
        ? await realpath(binding.workspacePath)
        : workspace.canonicalPath;
      if (
        workspacePath !== workspace.canonicalPath &&
        !(
          workspace.scope === "subdirectories" &&
          isPathInside(workspace.canonicalPath, workspacePath)
        )
      ) {
        throw new Error("Native runtime workspace escapes its provisioned root");
      }
      const assignedStat = await stat(workspacePath);
      if (!assignedStat.isDirectory()) {
        throw new Error("Native runtime assigned workspace is not a directory");
      }
      const assignedWorkspace: Workspace = {
        ...workspace,
        sourcePath: binding.workspacePath ?? workspace.sourcePath,
        canonicalPath: workspacePath,
        dev: assignedStat.dev,
        ino: assignedStat.ino,
      };
      assertOpen();
      const controller = new AbortController();
      activeTurns.add(controller);
      // A per-admission identifier prevents provider connection/cache state from
      // being shared across Gateway sessions or repeated external identifiers.
      const sessionId = randomUUID();
      const assertActive = () => {
        assertOpen();
        if (controller.signal.aborted) {
          throw new Error("Native runtime turn is closed");
        }
      };
      const streamFn: StreamFn = async (model, context, options) => {
        assertActive();
        if (model !== registered.model) {
          throw new Error("Native runtime requires the exact selected local model");
        }
        await assertWorkspace(workspace);
        await assertWorkspace(assignedWorkspace);
        assertActive();
        // Do not spread caller options: agent-loop options also contain config,
        // callbacks and provider-specific overrides outside SimpleStreamOptions.
        const localOptions: SimpleStreamOptions = {
          temperature: options?.temperature,
          // The startup registry owns the output budget, not Gateway model metadata.
          maxTokens: registered.model.maxTokens,
          reasoning: options?.reasoning,
          thinkingBudgets: options?.thinkingBudgets,
          responseFormat: options?.responseFormat,
          stop: options?.stop,
          serviceTier: options?.serviceTier,
          cacheRetention: options?.cacheRetention,
          timeoutMs: options?.timeoutMs,
          maxRetryDelayMs: options?.maxRetryDelayMs,
          onActiveResponse: options?.onActiveResponse,
          asyncToolExecution: options?.asyncToolExecution,
          apiKey: credentials.get(registered.apiKeyEnv)!,
          headers: { ...registered.headers },
          sessionId,
          transport: "sse",
          signal: options?.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal,
        };
        localOptions.signal?.throwIfAborted();
        return runtime.streamSimple(registered.model, context, localOptions);
      };
      try {
        const result = await callback({
          model: registered.model,
          streamFn,
          workspacePath,
          hasCredentialPrefix: (value) => {
            assertActive();
            return hasCredentialPrefix(value);
          },
          assertProtocolSafe: (value) => {
            assertActive();
            const serialized = JSON.stringify(value);
            if (
              [...protocolSecrets].some(
                (secret) =>
                  serialized.includes(secret) ||
                  serialized.includes(JSON.stringify(secret).slice(1, -1)),
              )
            ) {
              throw new Error("Native credential appeared in a protocol payload");
            }
          },
        });
        assertActive();
        await assertWorkspace(workspace);
        await assertWorkspace(assignedWorkspace);
        assertActive();
        return result;
      } finally {
        activeTurns.delete(controller);
        controller.abort();
        cleanupSessionResources(sessionId);
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const controller of activeTurns) {
        controller.abort();
      }
      activeTurns.clear();
      for (const registered of models.values()) {
        registered.headers = {};
      }
      credentials.clear();
      protocolSecrets.clear();
      models.clear();
      workspaces.clear();
      runtime.registry.clearApiProviders();
    },
  };
}
