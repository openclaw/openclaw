// Streams LLM responses through registered providers and normalizes events.
// This facade owns the process-default AI runtime wiring: it installs the
// OpenClaw host policy ports; the process-default runtime owns built-in registration.
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
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
  start: (model: Model) => AssistantMessageEventStreamContract,
): AssistantMessageEventStreamContract {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      const preparedModel = await prepareTransportModel(model);
      for await (const event of start(preparedModel)) {
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

async function prepareTransportModel<TApi extends Api>(model: Model<TApi>): Promise<Model<TApi>> {
  await ensureTransportRuntimeHost();
  const { prepareModelProviderRequestRouteFacts } =
    await import("../agents/provider-request-config.js");
  const preparedModel = await prepareModelProviderRequestRouteFacts(model);
  const {
    attachModelProviderRuntimePluginHandle,
    getModelProviderRuntimePluginHandle,
    resolveProviderRuntimePluginHandleAsync,
  } = await import("../plugins/provider-hook-runtime.js");
  if (getModelProviderRuntimePluginHandle(preparedModel)) {
    return preparedModel;
  }
  const runtimeHandle = await resolveProviderRuntimePluginHandleAsync({
    provider: preparedModel.provider,
    modelId: preparedModel.id,
  });
  return attachModelProviderRuntimePluginHandle(preparedModel, runtimeHandle);
}

function resolveRuntime(model: Model) {
  return getModelLlmRuntime(model) ?? defaultLlmRuntime;
}

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStreamContract {
  return deferUntilTransportRuntimeHost(model, (preparedModel) =>
    resolveRuntime(preparedModel).stream(preparedModel, context, options),
  );
}

export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
  assertCurrent?: () => void,
): Promise<AssistantMessage> {
  const preparedModel = await prepareTransportModel(model);
  assertCurrent?.();
  options?.signal?.throwIfAborted();
  return await resolveRuntime(preparedModel).complete(preparedModel, context, options);
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStreamContract {
  return deferUntilTransportRuntimeHost(model, (preparedModel) =>
    resolveRuntime(preparedModel).streamSimple(preparedModel, context, options),
  );
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  assertCurrent?: () => void,
): Promise<AssistantMessage> {
  const preparedModel = await prepareTransportModel(model);
  // Runtime setup can outlive its caller. Admit only a current request to the provider.
  assertCurrent?.();
  options?.signal?.throwIfAborted();
  return await resolveRuntime(preparedModel).completeSimple(preparedModel, context, options);
}
