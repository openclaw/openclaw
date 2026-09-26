import { resolveAgentDir } from "../agents/agent-scope-config.js";
import {
  createProviderHttpError,
  readProviderJsonResponse,
  readProviderTextResponse,
} from "../agents/provider-http-errors.js";
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { warn } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createDebugProxyWebSocketAgent, resolveDebugProxySettings } from "../proxy-capture/env.js";
import { captureWsEvent, captureWsEventAsync } from "../proxy-capture/runtime.js";
import { createRealtimeTranscriptionWebSocketSession } from "../realtime-transcription/websocket-session.js";
import type { PluginCapabilityCatalogHostContext } from "./capability-catalog-context.types.js";
import type { createProviderAuthAvailability } from "./provider-auth-availability-core.js";

export function createPluginCapabilityCatalogContext(
  availability: ReturnType<typeof createProviderAuthAvailability>,
): PluginCapabilityCatalogHostContext {
  const {
    isProviderApiKeyConfigured,
    isProviderAuthProfileConfigured,
    resolveProviderAuthProfileApiKey,
  } = availability;
  return Object.freeze({
    isProviderApiKeyConfigured,
    isProviderAuthProfileConfigured,
    resolveAgentDir,
    createRealtimeTranscriptionWebSocketSession,
    resolveProviderRequestHeaders,
    resolveProviderAuthProfileApiKey,
    resolveApiKeyForProvider: async (
      params: Parameters<PluginCapabilityCatalogHostContext["resolveApiKeyForProvider"]>[0],
    ) =>
      (await import("./runtime/runtime-model-auth.runtime.js")).resolveProviderRuntimeApiKey(
        params,
      ),
    captureWsEvent,
    captureWsEventAsync,
    createDebugProxyWebSocketAgent,
    resolveDebugProxySettings,
    fetchWithSsrFGuard,
    createProviderHttpError,
    readProviderJsonResponse,
    readProviderTextResponse,
    formatErrorMessage,
    warn,
    redactSensitiveText,
  });
}
