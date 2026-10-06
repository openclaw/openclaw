// Streams LLM responses through registered providers and normalizes events.
// This facade owns the process-default AI runtime wiring: it installs the
// OpenClaw host policy ports and registers built-in providers exactly once,
// before any caller imports the stream API.
import { defaultApiRegistry, defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { getModelLlmRuntime } from "./model-runtime-binding.js";
import "./ai-transport-host.js";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from "./types.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

registerBuiltInApiProviders(defaultApiRegistry);

// The process host outlives requests; only provider invocation carries caller authority.
const ensureTransportRuntimeHost = createLazyPromise(
  () => runInDetachedAsyncContext(() => import("../agents/ai-transport-runtime-host.js")),
  { cacheRejections: true },
);

function createRuntimeHostErrorMessage(model: Model, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: makeZeroUsageSnapshot(),
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    errorCode: classifyGatewayStorageFailure(error),
    timestamp: Date.now(),
  };
}

function deferUntilTransportRuntimeHost(
  model: Model,
  start: () => AssistantMessageEventStreamContract,
): AssistantMessageEventStreamContract {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      await ensureTransportRuntimeHost();
      for await (const event of start()) {
        output.push(event);
      }
    } catch (error) {
      const message = createRuntimeHostErrorMessage(model, error);
      output.push({ type: "error", reason: "error", error: message });
    } finally {
      output.end();
    }
  })();
  return output;
}

function resolveRuntime(model: Model) {
  return getModelLlmRuntime(model) ?? defaultLlmRuntime;
}

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStreamContract {
  return deferUntilTransportRuntimeHost(model, () =>
    resolveRuntime(model).stream(model, context, options),
  );
}

export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
  assertCurrent?: () => void,
): Promise<AssistantMessage> {
  await ensureTransportRuntimeHost();
  assertCurrent?.();
  options?.signal?.throwIfAborted();
  return await resolveRuntime(model).complete(model, context, options);
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStreamContract {
  return deferUntilTransportRuntimeHost(model, () =>
    resolveRuntime(model).streamSimple(model, context, options),
  );
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  assertCurrent?: () => void,
): Promise<AssistantMessage> {
  await ensureTransportRuntimeHost();
  // Runtime setup can outlive its caller. Admit only a current request to the provider.
  assertCurrent?.();
  options?.signal?.throwIfAborted();
  return await resolveRuntime(model).completeSimple(model, context, options);
}
