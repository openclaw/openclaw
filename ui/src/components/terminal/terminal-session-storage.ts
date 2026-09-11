// Session ids deliberately use per-tab storage: attach is a takeover, so shared
// local storage could let one Control UI window steal another window's shells.

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TerminalPanelAction } from "./terminal-panel-session-types.ts";

const TERMINAL_SESSIONS_KEY = "openclaw.terminal.sessions.v1";
const TERMINAL_ACTIONS_KEY = "openclaw.terminal.actions.v1";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function terminalAction(value: unknown): TerminalPanelAction | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "attach") {
    return nonEmptyString(value.sessionId) && typeof value.agentOwned === "boolean"
      ? {
          kind: "attach",
          sessionId: value.sessionId,
          agentOwned: value.agentOwned,
        }
      : null;
  }
  const agentId = value.agentId;
  if (agentId !== null && !nonEmptyString(agentId)) {
    return null;
  }
  if (value.kind === "restore" || value.kind === "open") {
    return { kind: value.kind, agentId };
  }
  return null;
}

export function loadPersistedTerminalSessionIds(scope = ""): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(TERMINAL_SESSIONS_KEY + scope);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function persistTerminalSessionIds(ids: readonly string[], scope = ""): void {
  try {
    globalThis.sessionStorage?.setItem(TERMINAL_SESSIONS_KEY + scope, JSON.stringify(ids));
  } catch {
    // Storage may be unavailable (private mode); reattach just won't work.
  }
}

export function loadPersistedTerminalActions(): TerminalPanelAction[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(TERMINAL_ACTIONS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.flatMap((value) => {
          const action = terminalAction(value);
          return action ? [action] : [];
        })
      : [];
  } catch {
    return [];
  }
}

export function persistTerminalActions(actions: readonly TerminalPanelAction[]): void {
  try {
    if (actions.length === 0) {
      globalThis.sessionStorage?.removeItem(TERMINAL_ACTIONS_KEY);
      return;
    }
    globalThis.sessionStorage?.setItem(TERMINAL_ACTIONS_KEY, JSON.stringify(actions));
  } catch {
    // In-memory replay still covers an unchanged document when storage is unavailable.
  }
}
