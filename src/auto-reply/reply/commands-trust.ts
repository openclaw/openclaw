import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const TRUST_PREFIX = "/trust";
const UNTRUST_PREFIX = "/untrust";
const TRUST_DEFAULT_MINUTES = 15;
const TRUST_MIN_MINUTES = 1;
const TRUST_MAX_MINUTES = 480;
const TRUST_USAGE = "Usage: /trust [minutes] (1-480, default 15)";
const UNTRUST_USAGE = "Usage: /untrust";

type TrustWindow = {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type TrustParseResult =
  | { kind: "no-match" }
  | { kind: "invalid"; message: string }
  | { kind: "parsed"; minutes: number };

type UntrustParseResult =
  | { kind: "no-match" }
  | { kind: "invalid"; message: string }
  | { kind: "parsed" };

const trustWindows = new Map<string, TrustWindow>();

function parseTrustCommand(raw: string): TrustParseResult {
  const match = raw.trim().match(/^\/trust(?:\s+(.+))?$/i);
  if (!match) {
    return { kind: "no-match" };
  }

  const minutesRaw = match[1]?.trim();
  if (!minutesRaw) {
    return { kind: "parsed", minutes: TRUST_DEFAULT_MINUTES };
  }
  if (!/^\d+$/.test(minutesRaw)) {
    return { kind: "invalid", message: TRUST_USAGE };
  }

  const minutes = Number.parseInt(minutesRaw, 10);
  if (!Number.isFinite(minutes) || minutes < TRUST_MIN_MINUTES || minutes > TRUST_MAX_MINUTES) {
    return {
      kind: "invalid",
      message: `Trust minutes must be between ${TRUST_MIN_MINUTES} and ${TRUST_MAX_MINUTES}. ${TRUST_USAGE}`,
    };
  }

  return { kind: "parsed", minutes };
}

function parseUntrustCommand(raw: string): UntrustParseResult {
  const match = raw.trim().match(/^\/untrust(?:\s+(.+))?$/i);
  if (!match) {
    return { kind: "no-match" };
  }
  if (match[1]?.trim()) {
    return { kind: "invalid", message: UNTRUST_USAGE };
  }
  return { kind: "parsed" };
}

function clearTrustWindow(sessionKey: string): boolean {
  const existing = trustWindows.get(sessionKey);
  if (!existing) {
    return false;
  }
  clearTimeout(existing.timer);
  trustWindows.delete(sessionKey);
  return true;
}

function getActiveTrustWindow(sessionKey: string, now = Date.now()): TrustWindow | undefined {
  const existing = trustWindows.get(sessionKey);
  if (!existing) {
    return undefined;
  }
  if (existing.expiresAt > now) {
    return existing;
  }
  clearTrustWindow(sessionKey);
  return undefined;
}

function formatRemainingTrust(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.ceil(seconds / 60)}m`;
}

export function resolveTrustedExecSecurity(sessionKey?: string): "full" | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return getActiveTrustWindow(sessionKey) ? "full" : undefined;
}

export function resetTrustCommandForTests(): void {
  for (const [sessionKey, window] of trustWindows) {
    clearTimeout(window.timer);
    trustWindows.delete(sessionKey);
  }
}

export const handleTrustCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseTrustCommand(params.command.commandBodyNormalized);
  if (parsed.kind === "no-match") {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, TRUST_PREFIX);
  if (unauthorized) {
    return unauthorized;
  }

  if (parsed.kind === "invalid") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${parsed.message}` },
    };
  }

  if (!params.sessionKey || !params.sessionEntry) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /trust requires an active session." },
    };
  }

  const now = Date.now();
  const existing = getActiveTrustWindow(params.sessionKey, now);
  if (existing) {
    const remaining = formatRemainingTrust(existing.expiresAt - now);
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Trust is already active for this session (${remaining} remaining). Cannot extend while active. Use /untrust first.`,
      },
    };
  }

  const durationMs = parsed.minutes * 60_000;
  const expiresAt = now + durationMs;
  const sessionKey = params.sessionKey;
  const timer = setTimeout(() => {
    const active = trustWindows.get(sessionKey);
    if (!active) {
      return;
    }
    if (active.expiresAt <= Date.now()) {
      trustWindows.delete(sessionKey);
    }
  }, durationMs);
  timer.unref?.();

  trustWindows.set(sessionKey, { expiresAt, timer });
  return {
    shouldContinue: false,
    reply: {
      text: `🔓 Trust enabled for ${parsed.minutes}m.`,
    },
  };
};

export const handleUntrustCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseUntrustCommand(params.command.commandBodyNormalized);
  if (parsed.kind === "no-match") {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, UNTRUST_PREFIX);
  if (unauthorized) {
    return unauthorized;
  }

  if (parsed.kind === "invalid") {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ ${parsed.message}` },
    };
  }

  if (!params.sessionKey || !params.sessionEntry) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /untrust requires an active session." },
    };
  }

  if (!clearTrustWindow(params.sessionKey)) {
    return {
      shouldContinue: false,
      reply: { text: "🔒 No active trust window for this session." },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: "🔒 Trust revoked for this session." },
  };
};
