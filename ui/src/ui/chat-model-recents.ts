import { normalizeProviderId } from "../../../src/agents/provider-id.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { buildChatModelOption } from "./chat-model-ref.ts";
import type { ModelCatalogEntry } from "./types.ts";

export type RecentChatModelEntry = {
  value: string;
  usedAt: number;
};

export type RankedChatModelOption = {
  value: string;
  label: string;
  provider?: string;
  isCustomProvider: boolean;
};

const RECENT_CHAT_MODELS_KEY = "openclaw.chat.recentModels";
const MAX_RECENT_CHAT_MODELS = 8;
const BUILTIN_PROVIDER_IDS = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai",
  "cerebras",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "groq",
  "huggingface",
  "kimi",
  "lmstudio",
  "minimax",
  "mistral",
  "ollama",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-portal",
  "sglang",
  "synthetic",
  "together",
  "vertex",
  "vllm",
  "xai",
  "zai",
]);

function storageOrNull(storage?: Storage): Storage | null {
  if (storage) {
    return storage;
  }
  return getSafeLocalStorage();
}

export function normalizeChatModelKey(value: string): string {
  return value.trim().toLowerCase();
}

export function isCustomProvider(provider?: string | null): boolean {
  const raw = String(provider ?? "").trim();
  if (!raw) {
    return false;
  }
  const normalized = normalizeProviderId(raw);
  return normalized.length > 0 && !BUILTIN_PROVIDER_IDS.has(normalized);
}

export function inferProviderFromModelRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return undefined;
  }
  return trimmed.slice(0, separator);
}

export function loadRecentChatModels(storage?: Storage): RecentChatModelEntry[] {
  const target = storageOrNull(storage);
  if (!target) {
    return [];
  }
  try {
    const raw = target.getItem(RECENT_CHAT_MODELS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is RecentChatModelEntry =>
          Boolean(entry) &&
          typeof entry.value === "string" &&
          entry.value.trim().length > 0 &&
          typeof entry.usedAt === "number" &&
          Number.isFinite(entry.usedAt),
      )
      .sort((a, b) => b.usedAt - a.usedAt)
      .slice(0, MAX_RECENT_CHAT_MODELS);
  } catch {
    return [];
  }
}

export function saveRecentChatModels(entries: RecentChatModelEntry[], storage?: Storage): void {
  const target = storageOrNull(storage);
  if (!target) {
    return;
  }
  target.setItem(
    RECENT_CHAT_MODELS_KEY,
    JSON.stringify(entries.slice(0, MAX_RECENT_CHAT_MODELS)),
  );
}

export function rememberRecentChatModel(value: string, storage?: Storage, now = Date.now()): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  const key = normalizeChatModelKey(trimmed);
  const current = loadRecentChatModels(storage);
  const next: RecentChatModelEntry[] = [
    { value: trimmed, usedAt: now },
    ...current.filter((entry) => normalizeChatModelKey(entry.value) !== key),
  ].slice(0, MAX_RECENT_CHAT_MODELS);
  saveRecentChatModels(next, storage);
}

function buildRankedChatModelOption(value: string, label: string, provider?: string): RankedChatModelOption {
  return {
    value,
    label,
    provider,
    isCustomProvider: isCustomProvider(provider),
  };
}

export function createCatalogRankedChatModelOption(entry: ModelCatalogEntry): RankedChatModelOption {
  const option = buildChatModelOption(entry);
  return buildRankedChatModelOption(option.value, option.label, entry.provider);
}

export function createSyntheticRankedChatModelOption(value: string): RankedChatModelOption {
  const provider = inferProviderFromModelRef(value);
  return buildRankedChatModelOption(value, value, provider);
}

export function sortRankedChatModelOptions(
  options: RankedChatModelOption[],
  recentEntries: RecentChatModelEntry[],
): RankedChatModelOption[] {
  const optionByKey = new Map<string, RankedChatModelOption>();
  for (const option of options) {
    optionByKey.set(normalizeChatModelKey(option.value), option);
  }

  const ranked: RankedChatModelOption[] = [];
  const used = new Set<string>();

  for (const entry of recentEntries) {
    const key = normalizeChatModelKey(entry.value);
    const option = optionByKey.get(key);
    if (!option || used.has(key)) {
      continue;
    }
    ranked.push(option);
    used.add(key);
  }

  for (const option of options) {
    const key = normalizeChatModelKey(option.value);
    if (used.has(key) || !option.isCustomProvider) {
      continue;
    }
    ranked.push(option);
    used.add(key);
  }

  for (const option of options) {
    const key = normalizeChatModelKey(option.value);
    if (used.has(key)) {
      continue;
    }
    ranked.push(option);
    used.add(key);
  }

  return ranked;
}
