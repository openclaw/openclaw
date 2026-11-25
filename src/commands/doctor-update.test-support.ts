import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import type { DoctorDatabasePreflight } from "./doctor-database-preflight.js";

export function externalDoctorEnv() {
  return buildUpdateDoctorEnv({
    allowGatewayServiceRepair: false,
    allowGatewayActivation: false,
    serviceRepairPolicy: "external",
    deferConfiguredPluginInstallRepair: true,
  });
}

export function pendingSchema(
  path: string,
  kind: "state" | "agent",
  foundVersion: number,
  supportedVersion: number,
  agentId?: string,
): DoctorDatabasePreflight {
  return {
    incompatible: [],
    indeterminate: [],
    pendingMigrations: [
      { path, kind, foundVersion, supportedVersion, ...(agentId ? { agentId } : {}) },
    ],
  };
}
