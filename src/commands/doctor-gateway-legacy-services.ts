import { LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES } from "../daemon/constants.js";
import type { ExtraGatewayService } from "../daemon/inspect.js";
import { uninstallLegacySystemdUnits } from "../daemon/systemd.js";
import type { RuntimeEnv } from "../runtime.js";

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

export async function cleanupLegacyLinuxUserServices(
  services: ExtraGatewayService[],
  runtime: RuntimeEnv,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];

  try {
    const removedUnits = await uninstallLegacySystemdUnits({
      env: process.env,
      stdout: process.stdout,
    });
    const removedByLabel: Map<string, (typeof removedUnits)[number]> = new Map(
      removedUnits.map((unit) => [`${unit.name}.service`, unit] as const),
    );
    for (const svc of services) {
      const removedUnit = removedByLabel.get(svc.label);
      if (!removedUnit) {
        failed.push(`${svc.label} (legacy unit name not recognized)`);
        continue;
      }
      removed.push(`${svc.label} -> ${removedUnit.unitPath}`);
    }
  } catch (err) {
    runtime.error(`Legacy Linux gateway cleanup failed: ${String(err)}`);
    for (const svc of services) {
      failed.push(`${svc.label} (linux cleanup failed)`);
    }
  }

  return { removed, failed };
}
