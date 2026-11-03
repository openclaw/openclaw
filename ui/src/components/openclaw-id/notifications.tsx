import { onSettled } from "solid-js";
import { bindOwnerApprovalNotifications } from "../../lib/openclaw-id/owner-approval-notifications.ts";
import { useApplication } from "../../lib/reactive/context.ts";

/** Owns approval notifications only for the enabled feature's mounted lifetime. */
export function OpenClawIdNotifications() {
  const context = useApplication();
  onSettled(() => bindOwnerApprovalNotifications(context.gateway));
  return null;
}
