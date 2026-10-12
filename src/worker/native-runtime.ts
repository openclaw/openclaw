import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  createNodeLlmRuntime,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
} from "@openclaw/ai";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { isCredentialFieldName } from "@openclaw/ai/internal/shared";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { z } from "zod";
import {
  NativeRuntimeConfigSchema,
  NativeRuntimeIdentifier as id,
  type NativeRuntimeConfig,
} from "./native-runtime-config.js";
import { nativeRuntimeModelUnsupportedReason } from "./native-runtime-model-support.js";
import { buildNativeRuntimeFetch } from "./native-runtime-transport.js";
const BindingSchema = z.object({ workspacePath: z.string().optional() });

type NativeRuntimeTurn = {
  binding: { workspacePath?: string };
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
};
type RegisteredModel = {
  model: Model;
  headers: Record<string, string>;
};
const SelectionSchema = z.strictObject({
  provider: NativeRuntimeConfigSchema.shape.models.element.shape.provider,
  modelId: id,
});
const MIN_CREDENTIAL_PREFIX_CHARS = 8;
const FULL_CREDENTIAL_PREFIX_SCAN_MAX_CHARS = 16;

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
  credentials: Readonly<Record<string, string>>,
): Promise<NativeRuntime> {
  const parsed = NativeRuntimeConfigSchema.parse(config);
  // The embedded loop can import the Gateway facade. Keep its process policy
  // out of this runtime's provider requests without resetting anyone else's host.
  const runtime = createNodeLlmRuntime(undefined, {
    buildModelFetch: buildNativeRuntimeFetch,
    requiresManagedTransport: () => true,
  });
  registerBuiltInApiProviders(runtime.registry);
  const models = new Map<string, RegisteredModel & { credential: string }>();
  const protocolSecrets = new Set<string>();
  const addProtocolSecret = (value: string) => {
    protocolSecrets.add(value);
    // HTTP Headers removes surrounding whitespace; guard that effective value too.
    const normalized = value.trim();
    if (normalized) {
      protocolSecrets.add(normalized);
    }
  };

  for (const entry of parsed.models) {
    const ref = `${entry.provider}/${entry.id}`;
    const credential = credentials[ref];
    if (!credential?.trim()) {
      throw new Error(`Native runtime credential is unavailable for ${ref}`);
    }
    addProtocolSecret(credential);
    const unsupportedReason = nativeRuntimeModelUnsupportedReason(entry.api, credential);
    if (!runtime.registry.getApiProvider(entry.api) || unsupportedReason) {
      throw new Error(unsupportedReason ?? `Unsupported native runtime API: ${entry.api}`);
    }
    const { headers: configuredHeaders, ...definition } = entry;
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
    models.set(ref, { model, credential, headers: Object.freeze(headers) });
    for (const [name, value] of Object.entries(headers)) {
      if (!value) {
        continue;
      }
      // Canonical provider headers are secret-bearing inputs. Model headers are
      // conservatively guarded too because startup has no second classification surface.
      addProtocolSecret(value);
      if (isCredentialFieldName(name)) {
        const token = /^(?:Bearer|Basic)\s+(\S+)$/iu.exec(value.trim())?.[1];
        if (token) {
          protocolSecrets.add(token);
        }
      }
    }
  }
  const sourcePath = path.resolve(parsed.workspace);
  const canonicalPath = await realpath(sourcePath);
  const directory = await stat(canonicalPath);
  if (!directory.isDirectory()) {
    throw new Error("Native runtime workspace must be a directory");
  }
  const workspace: Workspace = {
    sourcePath,
    canonicalPath,
    dev: directory.dev,
    ino: directory.ino,
  };
  const protocolSpellings = [...protocolSecrets].flatMap((secret) => [
    secret,
    JSON.stringify(secret).slice(1, -1),
  ]);

  const hasCredentialPrefix = (value: unknown): boolean => {
    if (typeof value === "string") {
      for (const secret of protocolSecrets) {
        const maxSize = Math.min(value.length, secret.length - 1);
        const minSize =
          secret.length <= FULL_CREDENTIAL_PREFIX_SCAN_MAX_CHARS ? 1 : MIN_CREDENTIAL_PREFIX_CHARS;
        for (let size = maxSize; size >= minSize && size > 0; size--) {
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
      const ref = `${selection.provider}/${selection.modelId}`;
      const registered = models.get(ref);
      if (!registered) {
        throw new Error("Native runtime model selection is not configured");
      }
      await assertWorkspace(workspace);
      const workspacePath = binding.workspacePath
        ? await realpath(binding.workspacePath)
        : workspace.canonicalPath;
      if (workspacePath !== workspace.canonicalPath) {
        throw new Error("Native runtime workspace does not match the admitted workspace");
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
          apiKey: registered.credential,
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
            if (protocolSpellings.some((secret) => serialized.includes(secret))) {
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
        registered.credential = "";
      }
      models.clear();
      protocolSecrets.clear();
      protocolSpellings.length = 0;
      runtime.registry.clearApiProviders();
    },
  };
}
