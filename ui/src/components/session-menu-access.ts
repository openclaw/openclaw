import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerSessionMenuPermissionsEnglish } from "../i18n/locales/en-session-menu-permissions.ts";
import { registerSessionOrganizationSharedEnglish } from "../i18n/locales/en-session-organization-shared.ts";
import {
  readSessionMethodAccess,
  sessionAccessRowForBatch,
  type SessionMethodAccessRequest,
} from "../lib/session-method-access.ts";
import type { CloudWorkerStopAction } from "./cloud-worker-stop.ts";
import type { SessionMenuActionKind } from "./session-menu-solid.tsx";
import { sessionPlacementActionReason } from "./session-placement-action.ts";

registerSessionOrganizationSharedEnglish();
registerSessionMenuPermissionsEnglish();

type SessionMenuAccessRow = Pick<
  GatewaySessionRow,
  "key" | "sessionId" | "archived" | "sharingRole"
> & {
  pinnable?: boolean;
};

export function sessionMenuReasons(params: {
  snapshot: ApplicationGatewaySnapshot | undefined;
  session: SessionMenuAccessRow;
  batchRows?: readonly SessionMenuAccessRow[] | null;
  cloudWorkerStopAction?: CloudWorkerStopAction | null;
  placementRow?: GatewaySessionRow;
  requiredProfile?: string;
}): Partial<Record<SessionMenuActionKind, string>> {
  const { snapshot, session, batchRows = null, cloudWorkerStopAction } = params;
  const reason = (missingScopeReasonKey: string, request: SessionMethodAccessRequest) => {
    const access = readSessionMethodAccess(snapshot, { ...request, missingScopeReasonKey });
    return access.allowed ? undefined : access.reason;
  };
  const involvementReason = reason("sessionsView.involvementPermissionDenied", {
    method: "sessions.setInvolvement",
    requiredScope: "operator.read",
    sessionScope: true,
  });
  const patchReason = (key: string, patch: Record<string, unknown>, sessionScope = false) =>
    reason(key, {
      method: "sessions.patch",
      params: { key: session.key, ...patch },
      sessionScope,
      session,
      allowDeferred: true,
    });
  const renameReason = patchReason("sessionsView.renamePermissionDenied", { label: null }, true);
  const promotionReason = !session.sessionId?.trim()
    ? t("sessionsView.lifecycleIdentityRequired")
    : patchReason("sessionsView.promotePermissionDenied", { sidebarRoot: true }, true);
  const iconReason = patchReason("sessionsView.iconPermissionDenied", { icon: null }, true);
  const colorReason = patchReason("sessionsView.colorPermissionDenied", { color: null }, true);
  const communicationReason = patchReason("sessionsView.communicationPermissionDenied", {
    communication: null,
  });
  const batchSession = batchRows ? sessionAccessRowForBatch(batchRows) : session;
  const batchPatchReason = (key: string, patch: Record<string, unknown>, sessionScope = false) => {
    if (!batchRows) {
      return patchReason(key, patch, sessionScope);
    }
    return reason(key, {
      method: "sessions.patchMany",
      sessionScope,
      session: batchSession,
      params: { patch },
    });
  };
  const unreadReason = batchPatchReason(
    "sessionsView.readStatusPermissionDenied",
    { unread: true },
    true,
  );
  const categoryReason = batchPatchReason("sessionsView.moveGroupPermissionDenied", {
    category: null,
  });
  const lifecycleRows = batchRows ?? [session];
  const archiveKey = batchRows
    ? batchRows.every((row) => row.archived)
      ? "sessionsView.restoreBatchPermissionDenied"
      : "sessionsView.archiveBatchPermissionDenied"
    : session.archived
      ? "sessionsView.restorePermissionDenied"
      : "sessionsView.archivePermissionDenied";
  const archiveReason = lifecycleRows.some((row) => !row.sessionId?.trim())
    ? t("sessionsView.lifecycleIdentityRequired")
    : batchRows &&
        snapshot?.phase === "connected" &&
        !snapshot.deferredIntentCount &&
        !snapshot.deferredIntentDraining
      ? batchPatchReason(archiveKey, { archived: true }, true)
      : lifecycleRows
          .map((row) =>
            reason(archiveKey, {
              method: "sessions.patch",
              params: { key: row.key, archived: !row.archived },
              sessionScope: true,
              session: row,
              allowDeferred: true,
            }),
          )
          .find((value) => value !== undefined);
  const snoozeReason = (key: string) =>
    !session.sessionId?.trim()
      ? t("sessionsView.lifecycleIdentityRequired")
      : patchReason(key, { snoozedUntil: null }, true);
  const snooze = snoozeReason("sessionsView.snoozePermissionDenied");
  const wake = snoozeReason("sessionsView.wakePermissionDenied");
  const groupReason = reason("sessionsView.createGroupPermissionDenied", {
    method: "sessions.groups.put",
    requiredScope: "operator.write",
  });
  const deleteReason = (batchRows ?? [session])
    .map((row) =>
      reason(
        batchRows
          ? "sessionsView.deleteBatchPermissionDenied"
          : "sessionsView.deletePermissionDenied",
        {
          method: "sessions.delete",
          allowDeferred: true,
          params: {
            key: row.key,
            ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
            ...(row.archived ? { archivedOnly: true } : {}),
          },
        },
      ),
    )
    .find((value): value is string => Boolean(value));
  const forkReason = batchRows
    ? undefined
    : reason("sessionsView.forkPermissionDenied", {
        method: "sessions.create",
        params: { parentSessionKey: session.key, fork: true },
        sessionScope: true,
        session,
      });
  const cloudWorkerStopReason = cloudWorkerStopAction
    ? reason("sessionsView.stopWorkerPermissionDenied", cloudWorkerStopAction)
    : undefined;
  const placementReason = params.placementRow
    ? sessionPlacementActionReason(snapshot, params.placementRow, params.requiredProfile)
    : undefined;
  return {
    ...(placementReason ? { "move-session": placementReason } : {}),
    ...(snooze ? { snooze } : {}),
    ...(wake ? { wake } : {}),
    ...(renameReason ? { rename: renameReason } : {}),
    ...(iconReason ? { "set-icon": iconReason } : {}),
    ...(colorReason ? { "set-color": colorReason } : {}),
    ...(communicationReason ? { "set-communication": communicationReason } : {}),
    ...(session.pinnable === false ? { "toggle-pin": t("sessionsView.pinRootSessionsOnly") } : {}),
    ...(unreadReason ? { "toggle-unread": unreadReason } : {}),
    ...(involvementReason ? { "toggle-involving-me": involvementReason } : {}),
    ...(categoryReason ? { "move-to-group": categoryReason } : {}),
    ...(archiveReason ? { "toggle-archived": archiveReason } : {}),
    ...(promotionReason ? { "move-to-top-level": promotionReason } : {}),
    ...(groupReason || categoryReason ? { "new-group": groupReason ?? categoryReason } : {}),
    ...(forkReason ? { fork: forkReason } : {}),
    ...(cloudWorkerStopReason ? { "stop-cloud-worker": cloudWorkerStopReason } : {}),
    ...(deleteReason ? { delete: deleteReason } : {}),
  };
}
