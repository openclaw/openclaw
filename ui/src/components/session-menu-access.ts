import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  readSessionMethodAccess,
  sessionAccessRowForBatch,
  type SessionMethodAccessRequest,
} from "../lib/session-method-access.ts";
import type { CloudWorkerStopAction } from "./cloud-worker-stop.ts";
import type { SessionMenuActionKind } from "./session-menu.ts";

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
}): Partial<Record<SessionMenuActionKind, string>> {
  const { snapshot, session, batchRows = null, cloudWorkerStopAction } = params;
  const reason = (request: SessionMethodAccessRequest) => {
    const access = readSessionMethodAccess(snapshot, request);
    return access.allowed ? undefined : access.reason;
  };
  const involvementReason = reason({
    method: "sessions.setInvolvement",
    requiredScope: "operator.read",
  });
  const patchReason = (patch: Record<string, unknown>, sessionScope = false) =>
    reason({
      method: "sessions.patch",
      params: { key: session.key, ...patch },
      sessionScope,
      session,
    });
  const renameReason = patchReason({ label: null }, true);
  const pinReason = patchReason({ pinned: true }, true);
  const iconReason = patchReason({ icon: null });
  const colorReason = patchReason({ color: null });
  const batchSession = batchRows ? sessionAccessRowForBatch(batchRows) : session;
  const batchPatchReason = (patch: Record<string, unknown>, sessionScope = false) => {
    if (!batchRows) {
      return patchReason(patch, sessionScope);
    }
    return reason({
      method: "sessions.patchMany",
      sessionScope,
      session: batchSession,
      params: { patch },
    });
  };
  const unreadReason = batchPatchReason({ unread: true });
  const categoryReason = batchPatchReason({ category: null });
  const lifecycleRows = batchRows ?? [session];
  const archiveReason = lifecycleRows.some((row) => !row.sessionId?.trim())
    ? "Session lifecycle action requires a durable session identity."
    : batchPatchReason({ archived: true }, true);
  const groupReason = reason({
    method: "sessions.groups.put",
    requiredScope: "operator.write",
  });
  const deleteReason = (batchRows ?? [session])
    .map((row) =>
      reason({
        method: "sessions.delete",
        params: {
          key: row.key,
          ...(row.sessionId ? { expectedSessionId: row.sessionId } : {}),
          ...(row.archived ? { archivedOnly: true } : {}),
        },
      }),
    )
    .find((value): value is string => Boolean(value));
  const forkReason = batchRows
    ? undefined
    : reason({
        method: "sessions.create",
        params: { parentSessionKey: session.key, fork: true },
      });
  const cloudWorkerStopReason = cloudWorkerStopAction ? reason(cloudWorkerStopAction) : undefined;
  return {
    ...(pinReason ? { "toggle-pin": pinReason } : {}),
    ...(renameReason ? { rename: renameReason } : {}),
    ...(iconReason ? { "set-icon": iconReason } : {}),
    ...(colorReason ? { "set-color": colorReason } : {}),
    ...(session.pinnable === false ? { "toggle-pin": t("sessionsView.pinRootSessionsOnly") } : {}),
    ...(unreadReason ? { "toggle-unread": unreadReason } : {}),
    ...(involvementReason ? { "toggle-involving-me": involvementReason } : {}),
    ...(categoryReason ? { "move-to-group": categoryReason } : {}),
    ...(archiveReason ? { "toggle-archived": archiveReason } : {}),
    ...(groupReason || categoryReason ? { "new-group": groupReason ?? categoryReason } : {}),
    ...(forkReason ? { fork: forkReason } : {}),
    ...(cloudWorkerStopReason ? { "stop-cloud-worker": cloudWorkerStopReason } : {}),
    ...(deleteReason ? { delete: deleteReason } : {}),
  };
}
