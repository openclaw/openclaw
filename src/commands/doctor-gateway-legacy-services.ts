import { LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES } from "../daemon/constants.js";
import type { ExtraGatewayService } from "../daemon/inspect.js";

export function classifyLegacyServices(legacyServices: ExtraGatewayService[]): {
  darwinUserServices: ExtraGatewayService[];
  linuxUserServices: ExtraGatewayService[];
  failed: string[];
} {
  const darwinUserServices: ExtraGatewayService[] = [];
  const linuxUserServices: ExtraGatewayService[] = [];
  const failed: string[] = [];

  for (const svc of legacyServices) {
    const userServices =
      svc.platform === "darwin"
        ? darwinUserServices
        : svc.platform === "linux"
          ? linuxUserServices
          : undefined;
    if (userServices && svc.scope === "user") {
      if (
        svc.platform === "linux" &&
        !LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES.some((name) => svc.label === `${name}.service`)
      ) {
        failed.push(`${svc.label} (legacy unit name not recognized)`);
      } else {
        userServices.push(svc);
      }
    } else {
      failed.push(`${svc.label} (${userServices ? svc.scope : svc.platform})`);
    }
  }

  return { darwinUserServices, linuxUserServices, failed };
}
