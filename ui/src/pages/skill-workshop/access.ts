import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";

export function resolveWorkshopAccess(snapshot: ApplicationGatewaySnapshot | null | undefined) {
  return {
    canArchive: canCallGatewayMethod(snapshot, "skills.workshop.archive", "operator.admin"),
    canRestore: canCallGatewayMethod(snapshot, "skills.workshop.restore", "operator.admin"),
    canSetMode: canCallGatewayMethod(snapshot, "config.patch", "operator.admin"),
  };
}
