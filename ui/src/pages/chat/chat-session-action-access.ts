import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";

export function holdPendingChatSessionAccess(
  access: SessionMethodAccess,
  pending: boolean | undefined,
): SessionMethodAccess {
  return pending
    ? {
        allowed: false,
        requiredScope: access.requiredScope,
        cause: "route-pending",
        reason: t("chat.thread.loading"),
      }
    : access;
}

export function readChatSessionActionAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  hasLocalRun: boolean,
  options: {
    session?: Pick<GatewaySessionRow, "sharingRole">;
    sessionAbortable?: boolean;
    routePending?: boolean;
  } = {},
) {
  const readAccess = (request: Parameters<typeof readSessionMethodAccess>[1]) =>
    holdPendingChatSessionAccess(readSessionMethodAccess(snapshot, request), options.routePending);
  const adminAction = (method: string) => readAccess({ method, requiredScope: "operator.admin" });
  return {
    compact: adminAction("sessions.compact"),
    abort: readAccess({
      method: hasLocalRun && !options.sessionAbortable ? "chat.abort" : "sessions.abort",
      requiredScope: "operator.write",
      sessionScope: true,
      session: options.session,
    }),
    rewind: adminAction("sessions.rewind"),
    fork: readAccess({
      method: "sessions.fork",
      requiredScope: "operator.write",
    }),
    reset: adminAction("sessions.reset"),
    branchSwitch: adminAction("sessions.branches.switch"),
  };
}
