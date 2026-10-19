import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { showToast } from "../../lib/toast.ts";

export function prepareArchiveOutcome(
  sessions: SessionCapability,
  { key, sessionId, pinned }: Pick<GatewaySessionRow, "key" | "sessionId" | "pinned">,
  agentId: string | undefined,
): ((result: SessionPatchResult) => void) | null {
  const connection = sessions.captureConnectionScope();
  if (!connection) {
    return null;
  }
  // Confirmation and Undo outlive the page, but keep the admitted connection and incarnation.
  return (result) => {
    if (!sessions.isConnectionScopeCurrent(connection) || result.entry.sessionId !== sessionId) {
      return;
    }
    showToast({
      message: t("sessionsView.sessionArchived"),
      actionLabel: t("common.undo"),
      onAction: () => {
        if (!sessions.isConnectionScopeCurrent(connection)) {
          return;
        }
        void sessions
          .patch(
            key,
            { archived: false, ...(pinned === true ? { pinned: true } : {}) },
            { agentId, expectedSessionId: sessionId },
          )
          .catch((error: unknown) => {
            if (sessions.isConnectionScopeCurrent(connection)) {
              showToast({ message: formatUiError(error) });
            }
          });
      },
    });
  };
}
