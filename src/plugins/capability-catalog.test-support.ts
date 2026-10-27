import type { PluginCapabilityCatalogHostContext } from "./capability-catalog-context.types.js";

export function createCatalogContextFixture(reject: () => never) {
  return {
    isProviderApiKeyConfigured: reject,
    isProviderApiKeyConfiguredAsync: reject,
    isProviderAuthProfileConfigured: reject,
    isProviderAuthProfileConfiguredAsync: reject,
    resolveAgentDir: reject,
    createRealtimeTranscriptionWebSocketSession: reject,
    resolveProviderRequestHeaders: reject,
    resolveProviderAuthProfileApiKey: reject,
    resolveApiKeyForProvider: reject,
    captureWsEvent: reject,
    captureWsEventAsync: reject,
    createDebugProxyWebSocketAgent: reject,
    resolveDebugProxySettings: reject,
    fetchWithSsrFGuard: reject,
    createProviderHttpError: reject,
    readProviderJsonResponse: reject,
    readProviderTextResponse: reject,
    formatErrorMessage: reject,
    warn: reject,
    redactSensitiveText: reject,
  } satisfies PluginCapabilityCatalogHostContext;
}
