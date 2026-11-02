import type { CronRuntimeAuthority } from "./runtime-authority.js";
import type { CronToolDefaultsMode } from "./tool-defaults.js";
import type { CronToolsAllowExecTarget, CronToolsAllowProvenance } from "./types.js";

/** Private host-approved unit; never accepted as public cron input. */
export type CronApprovedToolSelection = Readonly<{
  toolsAllow: readonly string[];
  toolsAllowMode?: CronToolDefaultsMode;
  toolsAllowProvenance: CronToolsAllowProvenance;
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
  runtimeAuthority?: CronRuntimeAuthority;
}>;
