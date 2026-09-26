import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  UpdateDatabaseGenerations,
  UpdateDatabaseWriteReceipt,
} from "../infra/update-database-generations.js";
import type { UpdateFailureFact } from "../infra/update-failure-facts.js";
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
};

export type DoctorMaintenance = {
  run<T>(operation: () => T): T;
  signal: AbortSignal;
  releaseState(): Promise<void>;
  release(): Promise<void>;
  finish(
    cfg: OpenClawConfig | undefined,
    writeConfig?: DoctorConfigWriter,
    failure?: unknown,
  ): Promise<void>;
  warnings?: string[];
  failureFacts?: UpdateFailureFact[];
  readonly databaseWrites?: UpdateDatabaseWriteReceipt;
};
