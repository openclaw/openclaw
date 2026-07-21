import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { areUiSessionKeysEquivalent } from "./sessions/session-key.ts";
import { normalizeOptionalString } from "./string-coerce.ts";

export const CONTROL_UI_DOCUMENT_TITLE = "OpenClaw Control";

type DocumentTitleState = {
  sessionKey?: string | null;
  activeSessionTitleRow?: GatewaySessionRow | null;
  sessionsResult?: SessionsListResult | null;
};

function findExactSessionTitleRow(rows: GatewaySessionRow[] | undefined, sessionKey: string) {
  return rows?.find((entry) => entry.key === sessionKey);
}

function findEquivalentSessionTitleRow(rows: GatewaySessionRow[] | undefined, sessionKey: string) {
  return rows?.find((entry) => areUiSessionKeysEquivalent(entry.key, sessionKey));
}

function findSessionTitleRow(state: DocumentTitleState, sessionKey: string) {
  const activeSessionTitleRow = state.activeSessionTitleRow;
  return (
    findExactSessionTitleRow(state.sessionsResult?.sessions, sessionKey) ??
    findEquivalentSessionTitleRow(state.sessionsResult?.sessions, sessionKey) ??
    (activeSessionTitleRow && areUiSessionKeysEquivalent(activeSessionTitleRow.key, sessionKey)
      ? activeSessionTitleRow
      : undefined)
  );
}

function isRawSessionKeyTitle(value: string, rowKey: string, sessionKey: string): boolean {
  return (
    value === rowKey ||
    value === sessionKey ||
    areUiSessionKeysEquivalent(value, rowKey) ||
    areUiSessionKeysEquivalent(value, sessionKey)
  );
}

function isGeneratedConversationDisplayNameRow(row: GatewaySessionRow): boolean {
  return (
    row.kind === "direct" ||
    row.kind === "group" ||
    row.key.includes(":direct:") ||
    row.key.includes(":group:") ||
    row.key.includes(":channel:") ||
    /^(?:direct|group|channel):/.test(row.key)
  );
}

function applyTypedSessionPrefix(rowKey: string, title: string): string {
  const prefix = rowKey.includes(":subagent:")
    ? "Subagent:"
    : rowKey.toLowerCase().startsWith("cron:") || rowKey.includes(":cron:")
      ? "Cron:"
      : "";
  if (!prefix || title.toLowerCase().startsWith(prefix.toLowerCase())) {
    return title;
  }
  return `${prefix} ${title}`;
}

function resolveSafeSessionTitle(row: GatewaySessionRow, sessionKey: string): string | null {
  const label = normalizeOptionalString(row.label);
  if (label && !isRawSessionKeyTitle(label, row.key, sessionKey)) {
    return applyTypedSessionPrefix(row.key, label);
  }
  const displayName = normalizeOptionalString(row.displayName);
  if (
    displayName &&
    !isRawSessionKeyTitle(displayName, row.key, sessionKey) &&
    !isGeneratedConversationDisplayNameRow(row)
  ) {
    return applyTypedSessionPrefix(row.key, displayName);
  }
  const derivedTitle = normalizeOptionalString(row.derivedTitle);
  if (derivedTitle && !isRawSessionKeyTitle(derivedTitle, row.key, sessionKey)) {
    return applyTypedSessionPrefix(row.key, derivedTitle);
  }
  return null;
}

export function resolveControlUiDocumentTitle(state: DocumentTitleState): string {
  const sessionKey = normalizeOptionalString(state.sessionKey);
  if (!sessionKey) {
    return CONTROL_UI_DOCUMENT_TITLE;
  }
  const row = findSessionTitleRow(state, sessionKey);
  if (!row) {
    return CONTROL_UI_DOCUMENT_TITLE;
  }
  const sessionName = resolveSafeSessionTitle(row, sessionKey);
  if (!sessionName || sessionName === CONTROL_UI_DOCUMENT_TITLE) {
    return CONTROL_UI_DOCUMENT_TITLE;
  }
  return `${sessionName} - ${CONTROL_UI_DOCUMENT_TITLE}`;
}

export function syncControlUiDocumentTitle(state: DocumentTitleState): void {
  if (typeof document === "undefined") {
    return;
  }
  const nextTitle = resolveControlUiDocumentTitle(state);
  if (document.title !== nextTitle) {
    document.title = nextTitle;
  }
}
