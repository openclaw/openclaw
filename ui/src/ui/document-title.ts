// Control UI document title helpers.
import { resolveSessionDisplayName } from "./session-display.ts";
import { areUiSessionKeysEquivalent } from "./session-key.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import type { SessionsListResult } from "./types.ts";

export const CONTROL_UI_DOCUMENT_TITLE = "OpenClaw Control";

type DocumentTitleState = {
  sessionKey?: string | null;
  sessionsResult?: SessionsListResult | null;
};

export function resolveControlUiDocumentTitle(state: DocumentTitleState): string {
  const sessionKey = normalizeOptionalString(state.sessionKey);
  if (!sessionKey) {
    return CONTROL_UI_DOCUMENT_TITLE;
  }
  const row = state.sessionsResult?.sessions.find((entry) =>
    areUiSessionKeysEquivalent(entry.key, sessionKey),
  );
  const sessionName = normalizeOptionalString(resolveSessionDisplayName(sessionKey, row));
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
