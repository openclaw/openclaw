import type { TtsProvider } from "../config/types.tts.js";
import type { ResolvedTtsConfig } from "./tts-config.js";
import {
  getExtensionHostTtsMaxLength,
  isExtensionHostTtsEnabled,
  isExtensionHostTtsSummarizationEnabled,
  resolveExtensionHostTtsAutoMode,
} from "./tts-preferences.js";
import {
  isExtensionHostTtsProviderConfigured,
  resolveExtensionHostTtsApiKey,
  resolveExtensionHostTtsProviderOrder,
} from "./tts-runtime-registry.js";
import { resolveExtensionHostTtsProvider } from "./tts-runtime-setup.js";

export type ExtensionHostTtsStatusEntry = {
  timestamp: number;
  success: boolean;
  textLength: number;
  summarized: boolean;
  provider?: string;
  latencyMs?: number;
  error?: string;
};

export type ExtensionHostTtsStatusSnapshot = {
  enabled: boolean;
  auto: ReturnType<typeof resolveExtensionHostTtsAutoMode>;
  provider: TtsProvider;
  providerConfigured: boolean;
  fallbackProvider: TtsProvider | null;
  fallbackProviders: TtsProvider[];
  prefsPath: string;
  maxLength: number;
  summarize: boolean;
  hasOpenAIKey: boolean;
  hasElevenLabsKey: boolean;
  edgeEnabled: boolean;
  lastAttempt?: ExtensionHostTtsStatusEntry;
};

let lastExtensionHostTtsAttempt: ExtensionHostTtsStatusEntry | undefined;

export function getExtensionHostLastTtsAttempt(): ExtensionHostTtsStatusEntry | undefined {
  return lastExtensionHostTtsAttempt;
}

export function setExtensionHostLastTtsAttempt(
  entry: ExtensionHostTtsStatusEntry | undefined,
): void {
  lastExtensionHostTtsAttempt = entry;
}

export function resolveExtensionHostTtsStatusSnapshot(params: {
  config: ResolvedTtsConfig;
  prefsPath: string;
}): ExtensionHostTtsStatusSnapshot {
  const { config, prefsPath } = params;
  const provider = resolveExtensionHostTtsProvider(config, prefsPath);
  const fallbackProviders = resolveExtensionHostTtsProviderOrder(provider)
    .slice(1)
    .filter((candidate) => isExtensionHostTtsProviderConfigured(config, candidate));
  return {
    enabled: isExtensionHostTtsEnabled(config, prefsPath),
    auto: resolveExtensionHostTtsAutoMode({ config, prefsPath }),
    provider,
    providerConfigured: isExtensionHostTtsProviderConfigured(config, provider),
    fallbackProvider: fallbackProviders[0] ?? null,
    fallbackProviders,
    prefsPath,
    maxLength: getExtensionHostTtsMaxLength(prefsPath),
    summarize: isExtensionHostTtsSummarizationEnabled(prefsPath),
    hasOpenAIKey: Boolean(resolveExtensionHostTtsApiKey(config, "openai")),
    hasElevenLabsKey: Boolean(resolveExtensionHostTtsApiKey(config, "elevenlabs")),
    edgeEnabled: isExtensionHostTtsProviderConfigured(config, "edge"),
    lastAttempt: getExtensionHostLastTtsAttempt(),
  };
}

export function formatExtensionHostTtsStatusText(
  status: ExtensionHostTtsStatusSnapshot,
  now = Date.now(),
): string {
  const lines = [
    "📊 TTS status",
    `State: ${status.enabled ? "✅ enabled" : "❌ disabled"}`,
    `Provider: ${status.provider} (${status.providerConfigured ? "✅ configured" : "❌ not configured"})`,
    `Text limit: ${status.maxLength} chars`,
    `Auto-summary: ${status.summarize ? "on" : "off"}`,
  ];
  if (!status.lastAttempt) {
    return lines.join("\n");
  }

  const timeAgo = Math.round((now - status.lastAttempt.timestamp) / 1000);
  lines.push("");
  lines.push(`Last attempt (${timeAgo}s ago): ${status.lastAttempt.success ? "✅" : "❌"}`);
  lines.push(
    `Text: ${status.lastAttempt.textLength} chars${status.lastAttempt.summarized ? " (summarized)" : ""}`,
  );
  if (status.lastAttempt.success) {
    lines.push(`Provider: ${status.lastAttempt.provider ?? "unknown"}`);
    lines.push(`Latency: ${status.lastAttempt.latencyMs ?? 0}ms`);
  } else if (status.lastAttempt.error) {
    lines.push(`Error: ${status.lastAttempt.error}`);
  }
  return lines.join("\n");
}
