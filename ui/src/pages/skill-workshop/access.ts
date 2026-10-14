import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";

export type SkillWorkshopAccess = {
  canArchive: boolean;
  canRestore: boolean;
  canSetMode: boolean;
};

export function resolveWorkshopAccess(
  snapshot: ApplicationGatewaySnapshot | null | undefined,
): SkillWorkshopAccess {
  return {
    canArchive: canCallGatewayMethod(snapshot, "skills.workshop.archive", "operator.admin"),
    canRestore: canCallGatewayMethod(snapshot, "skills.workshop.restore", "operator.admin"),
    canSetMode: canCallGatewayMethod(snapshot, "config.patch", "operator.admin"),
  };
}
