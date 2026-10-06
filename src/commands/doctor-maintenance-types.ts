import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";

export type DoctorConfigWriter = (nextConfig: OpenClawConfig) => Promise<OpenClawConfig>;

export type DoctorMaintenanceParams = {
  options: DoctorOptions;
  root: string | null;
  runtime: RuntimeEnv;
  runId?: string;
  assertCurrent?: () => void;
  databaseGenerations?: UpdateDatabaseGenerations;
  beforeStateMutation?: (context: { env: NodeJS.ProcessEnv; signal: AbortSignal }) => Promise<void>;
};
