import { onSettled } from "solid-js";
import { startOpenClawIdFeatureLifetime } from "../../lib/openclaw-id/feature-lifetime.ts";
import { bindOwnerApprovalNotifications } from "../../lib/openclaw-id/owner-approval-notifications.ts";
import { useApplication } from "../../lib/reactive/context.ts";

/** Owns the enabled feature's mounted lifetime: approval notifications and open dialogs end with it. */
export function OpenClawIdNotifications() {
  const context = useApplication();
  onSettled(() => {
    const end = startOpenClawIdFeatureLifetime();
    const unbind = bindOwnerApprovalNotifications(context.gateway);
    return () => {
      unbind();
      end();
    };
  });
  return null;
}
