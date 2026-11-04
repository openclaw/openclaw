import { ServiceFileInspectionError, scanSystemdDir } from "./inspect-files.js";
import type { ExtraGatewayService, ScannedGatewayService } from "./inspect-files.js";
import { DEFAULT_SYSTEMD_SYSTEM_UNIT_DIRS } from "./systemd-unit-load-paths.js";

function projectService({
  extra: _extra,
  managedGateway: _managed,
  ...service
}: ScannedGatewayService): ExtraGatewayService {
  return service;
}

export async function findSystemGatewayServices(): Promise<ExtraGatewayService[]> {
  if (process.platform !== "linux") {
    return [];
  }

  const results: ExtraGatewayService[] = [];
  // Scan failures (EACCES on a directory or on a unit file, ...) must surface:
  // callers that derive absence from an empty inventory would otherwise mistake
  // an unreadable unit path for a proven "no unit installed" verdict and let
  // publication fall back to caller defaults.
  const errors: ServiceFileInspectionError[] = [];
  for (const dir of DEFAULT_SYSTEMD_SYSTEM_UNIT_DIRS) {
    results.push(
      ...(
        await scanSystemdDir({
          dir,
          scope: "system",
          errors,
        })
      ).map(projectService),
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `Systemd unit inventory is incomplete: ${errors
        .map((error) => `${error.source}: ${error.message}`)
        .join("; ")}`,
    );
  }

  return results;
}
