// Installs OpenClaw-owned policy ports before package providers or shared
// transport helpers run. Direct transport imports need the same wiring as the
// process-default stream facade.
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiProviderRequestCapabilities,
  type AiTransportPluginHost,
} from "@openclaw/ai";
import { createAnthropicVertexStreamFnForModel } from "../agents/anthropic-vertex-stream.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "../agents/copilot-dynamic-headers.js";
import { ensureCustomApiRegistered } from "../agents/custom-api-registry.js";
import { prepareGoogleSimpleCompletionModel } from "../agents/google-simple-completion-stream.js";
import { resolveOpenAIStrictToolSetting } from "../agents/openai-strict-tool-setting.js";
import {
  resolveProviderRequestCapabilities,
  resolveProviderEndpoint,
} from "../agents/provider-attribution.js";
import {
  attachModelProviderLocalService,
  getModelProviderLocalService,
} from "../agents/provider-local-service.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
  resolveProviderRequestPolicyConfig,
} from "../agents/provider-request-config.js";
import {
  buildGuardedModelFetch,
  resolveModelRequestTimeoutMs,
} from "../agents/provider-transport-fetch.js";
import { transformTransportMessages } from "../agents/transport-message-transform.js";
import { redactSecrets, redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { swapSecretSentinelsInText } from "../secrets/sentinel.js";

const transportLogBySubsystem = new Map<string, ReturnType<typeof createSubsystemLogger>>();

function transportLog(subsystem: string): ReturnType<typeof createSubsystemLogger> {
  let log = transportLogBySubsystem.get(subsystem);
  if (!log) {
    log = createSubsystemLogger(subsystem);
    transportLogBySubsystem.set(subsystem, log);
  }
  return log;
}

/** Installs plugin-owned ports without making the eager stream facade load plugin runtime. */
export function configureAiTransportPluginHost(plugin: Partial<AiTransportPluginHost>): void {
  const host = getAiTransportHost();
  configureAiTransportHost({
    ...host,
    plugin: { ...host.plugin, ...plugin },
  });
}

configureAiTransportHost({
  buildModelFetch: buildGuardedModelFetch,
  resolveSecretSentinel: (value) => {
    const swapped = swapSecretSentinelsInText(value);
    const unknown = swapped.unknown[0];
    if (unknown) {
      throw new Error(
        `Secret sentinel ${unknown} is not registered in this process; refusing to construct provider client`,
      );
    }
    return swapped.text;
  },
  redactSecrets,
  redactToolPayloadText,
  resolveOpenAIStrictToolSetting,
  plugin: {
    ...getAiTransportHost().plugin,
    createAnthropicVertexStream: createAnthropicVertexStreamFnForModel,
  },
  buildCopilotDynamicHeaders: (messages) =>
    buildCopilotDynamicHeaders({ messages, hasImages: hasCopilotVisionInput(messages) }),
  resolveProviderEndpointClass: (baseUrl) => resolveProviderEndpoint(baseUrl).endpointClass,
  resolveProviderRequestCapabilities: (input) =>
    resolveProviderRequestCapabilities(input) as AiProviderRequestCapabilities,
  resolveProviderRequestHeaders: (input) =>
    resolveProviderRequestPolicyConfig({
      ...input,
      capability: "llm",
      transport: "stream",
    }).headers,
  resolveModelRequestTimeoutMs: (model) => resolveModelRequestTimeoutMs(model, undefined),
  requiresManagedTransport: (model) => {
    const request = getModelProviderRequestTransport(model);
    return Boolean(request?.proxy || request?.tls || getModelProviderLocalService(model));
  },
  inheritManagedTransport: (source, target) =>
    attachModelProviderLocalService(
      attachModelProviderRequestTransport(target, getModelProviderRequestTransport(source)),
      getModelProviderLocalService(source),
    ),
  transformTransportMessages,
  registerCustomApi: ensureCustomApiRegistered,
  prepareGoogleSimpleCompletionModel,
  logDebug: (subsystem, build) => {
    const log = transportLog(subsystem);
    if (!log.isEnabled("debug", "any")) {
      return;
    }
    const entry = build();
    if (entry) {
      log.debug(entry.message, entry.data);
    }
  },
  logInfo: (subsystem, message, data) => transportLog(subsystem).info(message, data),
  logWarn: (subsystem, message, data) => transportLog(subsystem).warn(message, data),
});
