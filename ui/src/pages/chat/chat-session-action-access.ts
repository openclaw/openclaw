import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";

export function readChatSessionActionAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  hasLocalRun: boolean,
  options: {
    session?: Pick<GatewaySessionRow, "sharingRole" | "invitedAccess">;
    sessionAbortable?: boolean;
    /** A pane can adopt another participant's run; the Gateway still checks its initiator. */
    runId?: string | null;
  } = {},
) {
  const adminAction = (method: string) =>
    readSessionMethodAccess(snapshot, { method, requiredScope: "operator.admin" });
  return {
    compact: adminAction("sessions.compact"),
    abort: readSessionMethodAccess(snapshot, {
      method: hasLocalRun && !options.sessionAbortable ? "chat.abort" : "sessions.abort",
      params: { runId: options.runId },
      requiredScope: "operator.write",
      sessionScope: true,
      session: options.session,
    }),
    rewind: adminAction("sessions.rewind"),
    fork: readSessionMethodAccess(snapshot, {
      method: "sessions.fork",
      requiredScope: "operator.write",
      sessionScope: true,
      session: options.session,
    }),
    reset: adminAction("sessions.reset"),
    branchSwitch: adminAction("sessions.branches.switch"),
  };
}
