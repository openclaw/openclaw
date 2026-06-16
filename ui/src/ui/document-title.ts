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
    (activeSessionTitleRow && activeSessionTitleRow.key === sessionKey
      ? activeSessionTitleRow
      : undefined) ??
    (activeSessionTitleRow && areUiSessionKeysEquivalent(activeSessionTitleRow.key, sessionKey)
      ? activeSessionTitleRow
      : undefined) ??
    findExactSessionTitleRow(state.chatSessionPickerResult?.sessions, sessionKey) ??
    findEquivalentSessionTitleRow(state.chatSessionPickerResult?.sessions, sessionKey)
  );
}

function resolveSafeSessionTitle(row: SessionsListResult["sessions"][number]): string | null {
  const label = normalizeOptionalString(row.label);
  if (label && label !== row.key) {
    return label;
  }
  const displayName = normalizeOptionalString(row.displayName);
  if (!displayName || displayName === row.key || row.kind === "direct" || row.kind === "group") {
    return null;
  }
  return displayName;
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
  const sessionName = resolveSafeSessionTitle(row);
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
