import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";

/** Presentation reasons only; commands still recheck current authority at dispatch. */
export function readChatPaneHeaderAccess(params: {
  snapshot: ApplicationGatewaySnapshot;
  row: GatewaySessionRow | undefined;
  hasLocalRun: boolean;
  working: boolean;
  archived: boolean;
}) {
  const { snapshot, row } = params;
  const branchSwitchAccess = readChatSessionActionAccess(snapshot, params.hasLocalRun).branchSwitch;
  const branchSwitchDisabledReason = params.archived
    ? t("chat.archivedSessionDisabled")
    : !branchSwitchAccess.allowed
      ? branchSwitchAccess.reason
      : params.working
        ? t("chat.sessionHeader.branchSwitchUnavailable")
        : null;
  const renameAccess = row
    ? readSessionMethodAccess(snapshot, {
        method: "sessions.patch",
        params: { key: row.key, label: null },
        sessionScope: true,
        session: row,
        allowDeferred: true,
      })
    : null;
  const renameDisabledReason = !renameAccess
    ? snapshot.phase !== "connected"
      ? t("sessionsView.actionRequiresConnection")
      : undefined
    : renameAccess.allowed
      ? undefined
      : renameAccess.reason;
  return { branchSwitchDisabledReason, renameDisabledReason };
}
