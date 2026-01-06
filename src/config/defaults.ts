import { resolveTalkApiKey } from "./talk.js";
import type { ClawdbotConfig } from "./types.js";

type WarnState = { warned: boolean };

let defaultWarnState: WarnState = { warned: false };

const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Anthropic (pi-ai catalog uses "latest" ids without date suffix)
  opus: "anthropic/claude-opus-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",

  // OpenAI
  gpt: "openai/gpt-5.2",
  "gpt-mini": "openai/gpt-5-mini",

  // Google Gemini (3.x are preview ids in the catalog)
  gemini: "google/gemini-3-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
};

export type SessionDefaultsOptions = {
  warn?: (message: string) => void;
  warnState?: WarnState;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyIdentityDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const identity = cfg.identity;
  if (!identity) return cfg;

  const name = identity.name?.trim();

  const routing = cfg.routing ?? {};
  const groupChat = routing.groupChat ?? {};

  let mutated = false;
  const next: ClawdbotConfig = { ...cfg };

  if (name && !groupChat.mentionPatterns) {
    const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
    const re = parts.length ? parts.join("\\s+") : escapeRegExp(name);
    const pattern = `\\b@?${re}\\b`;
    next.routing = {
      ...(next.routing ?? routing),
      groupChat: { ...groupChat, mentionPatterns: [pattern] },
    };
    mutated = true;
  }

  return mutated ? next : cfg;
}

export function applySessionDefaults(
  cfg: ClawdbotConfig,
  options: SessionDefaultsOptions = {},
): ClawdbotConfig {
  const session = cfg.session;
  if (!session || session.mainKey === undefined) return cfg;

  const trimmed = session.mainKey.trim();
  const warn = options.warn ?? console.warn;
  const warnState = options.warnState ?? defaultWarnState;

  const next: ClawdbotConfig = {
    ...cfg,
    session: { ...session, mainKey: "main" },
  };

  if (trimmed && trimmed !== "main" && !warnState.warned) {
    warnState.warned = true;
    warn('session.mainKey is ignored; main session is always "main".');
  }

  return next;
}

export function applyTalkApiKey(config: ClawdbotConfig): ClawdbotConfig {
  const resolved = resolveTalkApiKey();
  if (!resolved) return config;
  const existing = config.talk?.apiKey?.trim();
  if (existing) return config;
  return {
    ...config,
    talk: {
      ...config.talk,
      apiKey: resolved,
    },
  };
}

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
}

export function applyModelAliasDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const existingAgent = cfg.agent;
  if (!existingAgent) return cfg;
  const existingAliases = existingAgent?.modelAliases ?? {};

  const byNormalized = new Map<string, string>();
  for (const key of Object.keys(existingAliases)) {
    const norm = normalizeAliasKey(key);
    if (!norm) continue;
    if (!byNormalized.has(norm)) byNormalized.set(norm, key);
  }

  let mutated = false;
  const nextAliases: Record<string, string> = { ...existingAliases };

  for (const [canonicalKey, target] of Object.entries(DEFAULT_MODEL_ALIASES)) {
    const norm = normalizeAliasKey(canonicalKey);
    const existingKey = byNormalized.get(norm);

    if (!existingKey) {
      nextAliases[canonicalKey] = target;
      byNormalized.set(norm, canonicalKey);
      mutated = true;
      continue;
    }

    const existingValue = String(existingAliases[existingKey] ?? "");
    if (existingKey !== canonicalKey && existingValue === target) {
      delete nextAliases[existingKey];
      nextAliases[canonicalKey] = target;
      byNormalized.set(norm, canonicalKey);
      mutated = true;
    }
  }

  if (!mutated) return cfg;

  return {
    ...cfg,
    agent: {
      ...existingAgent,
      modelAliases: nextAliases,
    },
  };
}

export function applyLoggingDefaults(cfg: ClawdbotConfig): ClawdbotConfig {
  const logging = cfg.logging;
  if (!logging) return cfg;
  if (logging.redactSensitive) return cfg;
  return {
    ...cfg,
    logging: {
      ...logging,
      redactSensitive: "tools",
    },
  };
}

export function resetSessionDefaultsWarningForTests() {
  defaultWarnState = { warned: false };
}
