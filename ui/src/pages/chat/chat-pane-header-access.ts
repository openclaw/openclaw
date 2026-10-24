import type { AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  canDeleteSessionRows,
  isNativeCatalogAdoptionSessionKey,
  isPinnableUiSessionRow,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";

/** Presentation reasons only; commands still recheck current authority at dispatch. */
export function readChatPaneHeaderAccess(params: {
  snapshot: ApplicationGatewaySnapshot;
  row: GatewaySessionRow | undefined;
  agentsList: AgentsListResult | null;
  hasLocalRun: boolean;
  working: boolean;
  archived: boolean;
  continueInTerminalDisabledReason: string | undefined;
}) {
  const { snapshot, row, agentsList } = params;
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
  const mainKey = resolveUiConfiguredMainKey({ agentsList, hello: snapshot.hello });
  const deleteAllowed = Boolean(
    row && !isNativeCatalogAdoptionSessionKey(row.key) && canDeleteSessionRows([row], mainKey),
  );
  const pinnable = row != null && isPinnableUiSessionRow(row);
  const sessionActionDisabledReasons = row
    ? sessionMenuReasons({
        snapshot,
        placementRow: row,
        requiredProfile: agentsList?.sessionPlacement?.requiredProfile?.id,
        session: { ...row, pinnable },
      })
    : {};
  const assignmentAccess = row
    ? readSessionMethodAccess(snapshot, {
        method: "sessions.assignOwner",
        params: {
          key: row.key,
          owner: { type: "human", id: snapshot.selfUser?.id ?? "profile" },
        },
        requiredScope: "operator.write",
      })
    : null;
  const actionDisabledReasons = {
    ...sessionActionDisabledReasons,
    ...(assignmentAccess && !assignmentAccess.allowed
      ? { "assign-owner": assignmentAccess.reason }
      : {}),
    ...(params.continueInTerminalDisabledReason
      ? { "continue-in-terminal": params.continueInTerminalDisabledReason }
      : {}),
  };
  return {
    branchSwitchDisabledReason,
    renameDisabledReason,
    mainKey,
    deleteAllowed,
    pinnable,
    actionDisabledReasons,
  };
}
