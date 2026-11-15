import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { WorkshopMutation } from "./api.ts";

/**
 * Workshop is the bundled skill-workshop plugin; it can be disabled or absent from a package.
 * False only once the Gateway's method catalog shows that, so a pending hello hides nothing.
 */
export function isSkillWorkshopInstalled(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello"> | null | undefined,
): boolean {
  return isGatewayMethodAdvertised(snapshot ?? {}, "skills.workshop.list") !== false;
}

export function resolveWorkshopAccess(snapshot: ApplicationGatewaySnapshot | null | undefined) {
  return {
    canArchive: canCallGatewayMethod(snapshot, "skills.workshop.archive", "operator.admin"),
    canRestore: canCallGatewayMethod(snapshot, "skills.workshop.restore", "operator.admin"),
    // Apply and Discard ship together and share their scope.
    canReviewDrafts: canCallGatewayMethod(snapshot, "skills.workshop.applyDraft", "operator.admin"),
    canSetMode: canCallGatewayMethod(snapshot, "config.patch", "operator.admin"),
    canEnablePlugin: canCallGatewayMethod(snapshot, "plugins.setEnabled", "operator.admin"),
  };
}

export function canRunWorkshopMutation(
  access: ReturnType<typeof resolveWorkshopAccess>,
  method: WorkshopMutation["method"],
): boolean {
  return {
    "skills.workshop.archive": access.canArchive,
    "skills.workshop.restore": access.canRestore,
    "skills.workshop.applyDraft": access.canReviewDrafts,
    "skills.workshop.discardDraft": access.canReviewDrafts,
  }[method];
}
