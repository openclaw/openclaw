import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

const TUI_SESSION_TOKEN_RE = /^tui-[a-z0-9][a-z0-9._-]*$/i;
const SESSION_TUI_RE = /^session(?::|\s+)(tui-[a-z0-9][a-z0-9._-]*)$/i;

function normalizeTuiSessionRest(rest: string): string | undefined {
  const raw = normalizeOptionalString(rest);
  if (!raw) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  const direct = TUI_SESSION_TOKEN_RE.test(lower) ? lower : undefined;
  if (direct) {
    return `session ${direct}`;
  }
  const match = SESSION_TUI_RE.exec(lower);
  if (match?.[1]) {
    return `session ${match[1]}`;
  }
  return undefined;
}

export function normalizeUserProvidedSessionKey(
  value: string,
  opts?: { defaultAgentId?: string },
): string {
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return "";
  }

  const parsed = parseAgentSessionKey(raw);
  const agentId = parsed?.agentId ?? normalizeAgentId(opts?.defaultAgentId);
  const rest = parsed?.rest ?? raw;
  const normalizedTuiRest = normalizeTuiSessionRest(rest);
  if (!normalizedTuiRest) {
    return raw;
  }
  return `agent:${agentId}:${normalizedTuiRest}`;
}

export function isUserProvidedTuiSessionAlias(value: string): boolean {
  return normalizeUserProvidedSessionKey(value) !== (normalizeOptionalString(value) ?? "");
}
