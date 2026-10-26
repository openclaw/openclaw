// This facade owns the process-default AI runtime wiring: it installs the
// OpenClaw host policy ports and registers built-in providers exactly once,
// before any caller imports the stream API.
import { defaultApiRegistry, defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { POSTGRES_QUERY_CANCELED_ERROR_NAME } from "../infra/postgres-sync/protocol.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-error.js";
import { assertProviderAuthAuthority } from "../plugins/provider-auth-authority.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { getModelLlmRuntime } from "./model-runtime-binding.js";
import { getModelTransportContext } from "./model-transport-context.js";
import { createProviderRateLimitRequest } from "./provider-rate-limit.js";
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
  // A message cannot retain the error graph, so preserve its strongest continuation fence.
  const storageFailure = hasSqliteWorkerOutcomeUnknown(error)
    ? "session_actor_reconciliation"
    : classifyGatewayStorageFailure(error);
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: makeZeroUsageSnapshot(),
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    errorCode: storageFailure,
    errorType:
      storageFailure === "57014"
        ? POSTGRES_QUERY_CANCELED_ERROR_NAME
        : storageFailure === "unavailable"
          ? "SqliteWorkerError"
          : undefined,
    timestamp: Date.now(),
  };
}

function deferUntilTransportRuntimeHost<T extends SimpleStreamOptions>(
  model: Model,
  start: (options: T) => AssistantMessageEventStreamContract,
  options: T,
): AssistantMessageEventStreamContract {
  const output = createAssistantMessageEventStream();
  const admission = createProviderRateLimitRequest(model, options);
  const transportContext = getModelTransportContext();
  void (async () => {
    try {
      await ensureTransportRuntimeHost();
      await admission.wait(transportContext?.onRateLimitWait, transportContext?.priority);
      assertProviderAuthAuthority(model);
      options?.signal?.throwIfAborted();
      for await (const event of start(admission.options)) {
        if (event.type === "error") {
          admission.observe?.(event.error);
        }
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
  return deferUntilTransportRuntimeHost(
    model,
    (admittedOptions) => resolveRuntime(model).stream(model, context, admittedOptions),
    options ?? {},
  );
}

export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
  assertCurrent?: () => void,
): Promise<AssistantMessage> {
  await ensureTransportRuntimeHost();
  const admission = createProviderRateLimitRequest(model, options ?? {});
  const transportContext = getModelTransportContext();
  await admission.wait(transportContext?.onRateLimitWait, transportContext?.priority);
  assertCurrent?.();
  assertProviderAuthAuthority(model);
  options?.signal?.throwIfAborted();
  const result = await resolveRuntime(model).complete(model, context, admission.options);
  admission.observe?.(result);
  return result;
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStreamContract {
  return deferUntilTransportRuntimeHost(
    model,
    (admittedOptions) => resolveRuntime(model).streamSimple(model, context, admittedOptions),
    options ?? {},
  );
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  assertCurrent?: () => void,
): Promise<AssistantMessage> {
  await ensureTransportRuntimeHost();
  const admission = createProviderRateLimitRequest(model, options ?? {});
  const transportContext = getModelTransportContext();
  await admission.wait(transportContext?.onRateLimitWait, transportContext?.priority);
  // Runtime setup can outlive its caller. Admit only a current request to the provider.
  assertCurrent?.();
  assertProviderAuthAuthority(model);
  options?.signal?.throwIfAborted();
  const result = await resolveRuntime(model).completeSimple(model, context, admission.options);
  admission.observe?.(result);
  return result;
}
