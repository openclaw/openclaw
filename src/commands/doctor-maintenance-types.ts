import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";

export type DoctorConfigWriter = (nextConfig: OpenClawConfig) => Promise<OpenClawConfig>;

export type DoctorMaintenanceParams = {
  options: DoctorOptions;
  env?: NodeJS.ProcessEnv;
  /** Prelaunch callers can wait for another migration without managing services. */
  waitForMaintenance?: boolean;
  /** Interactive custody consent does not auto-approve individual repairs. */
  interactiveRepair?: boolean;
  root: string | null;
  runtime: RuntimeEnv;
  runId?: string;
  assertCurrent?: () => void;
  lendPolicyCustody?: import("../infra/update-doctor-result.js").UpdateDoctorWriteAuthority["lendPolicyCustody"];
  databaseGenerations?: UpdateDatabaseGenerations;
  databasePluginOwners?: import("../infra/database-engine/port-descriptor.js").DatabasePortPluginOwners;
  /** Public update repair names the next step when it leaves a managed Gateway stopped. */
  reportStoppedService?: boolean;
  /** Parent Doctor phase deadline for nested managed-service inspection. */
  serviceInspectionDeadlineAtMs?: number;
  beforeStateMutation?: (context: { env: NodeJS.ProcessEnv; signal: AbortSignal }) => Promise<void>;
};
