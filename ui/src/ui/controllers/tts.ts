import type { GatewayBrowserClient } from "../gateway";

export type TtsProviderId = "openai" | "elevenlabs" | "edge";

export type TtsProviderInfo = {
  id: TtsProviderId;
  name: string;
  configured: boolean;
  models: string[];
  voices?: string[];
};

export type TtsProvidersSnapshot = {
  providers: TtsProviderInfo[];
  active: TtsProviderId | null;
};

export type TtsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  ttsLoading: boolean;
  ttsError: string | null;
  ttsProviders: TtsProviderInfo[];
  ttsActiveProvider: TtsProviderId | null;
};

const PROVIDER_IDS = new Set<TtsProviderId>(["openai", "elevenlabs", "edge"]);

function isProviderId(value: unknown): value is TtsProviderId {
  return typeof value === "string" && PROVIDER_IDS.has(value as TtsProviderId);
}

function normalizeProvider(entry: Record<string, unknown>): TtsProviderInfo | null {
  const id = isProviderId(entry.id) ? entry.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof entry.name === "string" ? entry.name : id,
    configured: entry.configured === true,
    models: Array.isArray(entry.models)
      ? entry.models.map((m) => String(m)).filter(Boolean)
      : [],
    voices: Array.isArray(entry.voices)
      ? entry.voices.map((v) => String(v)).filter(Boolean)
      : undefined,
  };
}

export async function loadTtsProviders(state: TtsState, opts?: { quiet?: boolean }) {
  if (!state.client || !state.connected) return;
  if (state.ttsLoading) return;
  state.ttsLoading = true;
  if (!opts?.quiet) state.ttsError = null;
  try {
    const res = (await state.client.request("tts.providers", {})) as TtsProvidersSnapshot;
    const providers = Array.isArray(res?.providers) ? res.providers : [];
    state.ttsProviders = providers
      .map((entry) => normalizeProvider(entry as Record<string, unknown>))
      .filter((entry): entry is TtsProviderInfo => Boolean(entry));
    state.ttsActiveProvider = isProviderId(res?.active) ? res.active : null;
  } catch (err) {
    if (!opts?.quiet) state.ttsError = String(err);
  } finally {
    state.ttsLoading = false;
  }
}

export async function setTtsProvider(state: TtsState, provider: TtsProviderId) {
  if (!state.client || !state.connected) return;
  state.ttsError = null;
  try {
    await state.client.request("tts.setProvider", { provider });
    await loadTtsProviders(state, { quiet: true });
  } catch (err) {
    state.ttsError = String(err);
  }
}
