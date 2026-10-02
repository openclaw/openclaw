import type { GatewaySessionRow } from "../../api/types.ts";
import { confirmSessionArchive } from "../../components/session-archive-confirmation.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { archiveAutomationPauseNotice } from "../../lib/sessions/automation-pause.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { showToast } from "../../lib/toast.ts";

function prepareArchiveOutcome(
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
    const notice = archiveAutomationPauseNotice([result.automationPause]);
    showToast({
      message: [t("sessionsView.sessionArchived"), notice?.message].filter(Boolean).join(". "),
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

/** Own the confirmation, committed receipt, and archive presentation hold together. */
export async function archiveSessionWithUndo(
  sessions: SessionCapability,
  row: GatewaySessionRow,
  agentId: string | undefined,
  options: Omit<Parameters<typeof confirmSessionArchive>[0], "targets"> & {
    patch: (onConfirmed: (result: SessionPatchResult) => void) => Promise<unknown>;
  },
): Promise<void> {
  if (!(await confirmSessionArchive({ ...options, targets: [{ ...row, agentId }] }))) {
    return;
  }
  const onConfirmed = prepareArchiveOutcome(sessions, row, agentId);
  if (!onConfirmed) {
    return;
  }
  const finishArchive = sessions.beginArchive(row.key, row.sessionId);
  if (!finishArchive) {
    return;
  }
  try {
    await options.patch(onConfirmed);
  } finally {
    finishArchive();
  }
}
