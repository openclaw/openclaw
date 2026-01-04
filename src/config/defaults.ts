import { resolveTalkApiKey } from "./talk.js";
import type { ClawdbotConfig } from "./types.js";

type WarnState = { warned: boolean };

let defaultWarnState: WarnState = { warned: false };

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

export function resetSessionDefaultsWarningForTests() {
  defaultWarnState = { warned: false };
}
