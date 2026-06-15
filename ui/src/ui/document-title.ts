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

function findSessionTitleRow(state: DocumentTitleState, sessionKey: string) {
  const activeSessionTitleRow = state.activeSessionTitleRow;
  return (
    state.sessionsResult?.sessions.find((entry) =>
      areUiSessionKeysEquivalent(entry.key, sessionKey),
    ) ??
    (activeSessionTitleRow && areUiSessionKeysEquivalent(activeSessionTitleRow.key, sessionKey)
      ? activeSessionTitleRow
      : undefined) ??
    state.chatSessionPickerResult?.sessions.find((entry) =>
      areUiSessionKeysEquivalent(entry.key, sessionKey),
    )
  );
}

function resolveSafeSessionTitle(row: SessionsListResult["sessions"][number]): string | null {
  return normalizeOptionalString(row.label) ?? normalizeOptionalString(row.displayName) ?? null;
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
