// Control UI chat module owns realtime Talk catalog compatibility.

export type RealtimeTalkCatalogProvider = {
  id: string;
  label: string;
  configured: boolean;
  transports?: string[];
  supportsBrowserSession?: boolean;
};

export type RealtimeTalkCatalogSelection = {
  provider: string;
  transport: string;
};

export const REALTIME_TALK_FALLBACK_PROVIDERS = [
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google" },
] as const;

const CONTROL_UI_CLIENT_TRANSPORTS = new Set(["webrtc", "gateway-relay"]);
const CONTROL_UI_PROVIDER_WEBSOCKET_IDS = new Set(["google"]);

export function resolveControlUiRealtimeTalkProviderTransports(
  provider: RealtimeTalkCatalogProvider,
): string[] {
  if (!provider.configured) {
    return [];
  }
  // Realtime voice capabilities are optional; bridge-only providers use the
  // gateway relay when they do not declare a transport list.
  const transports = provider.transports ?? ["gateway-relay"];
  return transports.filter(
    (transport) =>
      transport === "gateway-relay" ||
      (provider.supportsBrowserSession === true && CONTROL_UI_CLIENT_TRANSPORTS.has(transport)) ||
      (provider.supportsBrowserSession === true &&
        transport === "provider-websocket" &&
        CONTROL_UI_PROVIDER_WEBSOCKET_IDS.has(provider.id)),
  );
}

export function listSelectableRealtimeTalkProviders(
  providers: RealtimeTalkCatalogProvider[],
): RealtimeTalkCatalogProvider[] {
  return providers.filter(
    (provider) => resolveControlUiRealtimeTalkProviderTransports(provider).length > 0,
  );
}

export function reconcileRealtimeTalkCatalogSelection(params: {
  providers: RealtimeTalkCatalogProvider[];
  selection: RealtimeTalkCatalogSelection;
}): Partial<RealtimeTalkCatalogSelection> | null {
  const providerId = params.selection.provider;
  if (!providerId) {
    return null;
  }
  const provider = listSelectableRealtimeTalkProviders(params.providers).find(
    (entry) => entry.id === providerId,
  );
  if (!provider) {
    return { provider: "", transport: "" };
  }
  const transport = params.selection.transport;
  if (transport && !resolveControlUiRealtimeTalkProviderTransports(provider).includes(transport)) {
    return { transport: "" };
  }
  return null;
}
