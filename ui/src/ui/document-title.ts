import { parseSessionKey } from "./session-display.ts";
// Control UI document title helpers.
import { areUiSessionKeysEquivalent } from "./session-key.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import type { SessionsListResult } from "./types.ts";

export const CONTROL_UI_DOCUMENT_TITLE = "OpenClaw Control";

type DocumentTitleState = {
  sessionKey?: string | null;
  activeSessionTitleRow?: SessionsListResult["sessions"][number] | null;
  chatSessionPickerResult?: SessionsListResult | null;
  sessionsResult?: SessionsListResult | null;
};

function findExactSessionTitleRow(
  rows: SessionsListResult["sessions"] | undefined,
  sessionKey: string,
) {
  return rows?.find((entry) => entry.key === sessionKey);
}

function findEquivalentSessionTitleRow(
  rows: SessionsListResult["sessions"] | undefined,
  sessionKey: string,
) {
  return rows?.find((entry) => areUiSessionKeysEquivalent(entry.key, sessionKey));
}

function findSessionTitleRow(state: DocumentTitleState, sessionKey: string) {
  const activeSessionTitleRow = state.activeSessionTitleRow;
  return (
    findExactSessionTitleRow(state.sessionsResult?.sessions, sessionKey) ??
    findEquivalentSessionTitleRow(state.sessionsResult?.sessions, sessionKey) ??
    findExactSessionTitleRow(state.chatSessionPickerResult?.sessions, sessionKey) ??
    findEquivalentSessionTitleRow(state.chatSessionPickerResult?.sessions, sessionKey) ??
    (activeSessionTitleRow && activeSessionTitleRow.key === sessionKey
      ? activeSessionTitleRow
      : undefined) ??
    (activeSessionTitleRow && areUiSessionKeysEquivalent(activeSessionTitleRow.key, sessionKey)
      ? activeSessionTitleRow
      : undefined)
  );
}

function isRawSessionKeyTitle(value: string, rowKey: string, sessionKey: string): boolean {
  return value === rowKey || value === sessionKey;
}

function isGeneratedConversationDisplayNameRow(
  row: SessionsListResult["sessions"][number],
): boolean {
  return (
    row.origin != null ||
    row.chatType === "direct" ||
    row.chatType === "group" ||
    row.chatType === "channel" ||
    row.key.includes(":direct:") ||
    row.key.includes(":group:") ||
    row.key.includes(":channel:") ||
    /^(?:direct|group|channel):/.test(row.key)
  );
}

function applyTypedSessionPrefix(rowKey: string, title: string): string {
  const { prefix } = parseSessionKey(rowKey);
  if (!prefix) {
    return title;
  }
  const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
  return prefixPattern.test(title) ? title : `${prefix} ${title}`;
}

function resolveSafeSessionTitle(
  row: SessionsListResult["sessions"][number],
  sessionKey: string,
): string | null {
  const label = normalizeOptionalString(row.label);
  if (label && !isRawSessionKeyTitle(label, row.key, sessionKey)) {
    return applyTypedSessionPrefix(row.key, label);
  }
  const displayName = normalizeOptionalString(row.displayName);
  if (
    !displayName ||
    isRawSessionKeyTitle(displayName, row.key, sessionKey) ||
    isGeneratedConversationDisplayNameRow(row)
  ) {
    return null;
  }
  return applyTypedSessionPrefix(row.key, displayName);
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
