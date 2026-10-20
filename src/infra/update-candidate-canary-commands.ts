import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type UpdateCanaryCommand = {
  phase: "doctor" | "lint" | "config" | "plugins" | "runtime";
  name: string;
  args: string[];
  entry?: string;
};

export function buildUpdateCanaryCommands(params: {
  continuationEntry: string;
  migrationPolicy?: "rehearse" | "startup-only";
  fullIntegrityCheck?: boolean;
}): UpdateCanaryCommand[] {
  const runtime: UpdateCanaryCommand = {
    phase: "runtime",
    name: "candidate-recovery",
    // After a schema bump only a fresh candidate may finalize the run;
    // prove its full recovery import graph before live state changes.
    entry: params.continuationEntry,
    args: ["--check"],
  };
  if (params.migrationPolicy === "startup-only") {
    return [runtime];
  }
  return [
    {
      phase: "doctor",
      name: "candidate-doctor",
      args: [
        "doctor",
        "--fix",
        "--non-interactive",
        "--no-workspace-suggestions",
        ...(params.fullIntegrityCheck ? ["--full-integrity-check"] : []),
      ],
    },
    {
      phase: "lint",
      name: "candidate-doctor-lint",
      args: ["doctor", "--lint", "--json", "--severity-min", "error"],
    },
    {
      phase: "config",
      name: "candidate-config",
      args: ["config", "validate", "--json"],
    },
    {
      phase: "plugins",
      name: "candidate-plugins",
      args: ["plugins", "list", "--json"],
    },
    runtime,
  ];
}

export type CanaryPhase = UpdateCanaryCommand["phase"] | "snapshot" | "startup" | "readiness";

export type CanaryOutcome =
  | { status: "ok" }
  | {
      status: "error";
      reason:
        | "doctor-failed"
        | "candidate-checks-timeout"
        | "candidate-snapshot-failed"
        | "runtime-verification-failed";
    };

export type CanaryResult = {
  phase: CanaryPhase;
  durationMs: number;
  logTail: string[];
  steps: UpdateStepResult[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
  gatewayRestartCompletion?: boolean;
  doctorConfigWrites?: boolean;
  doctorConfigChanges?: UpdateDoctorConfigChange[];
  listenerIsolation?: {
    gateway: { host: "127.0.0.1"; port: number };
    mcpAppSandbox: "disabled";
  };
} & CanaryOutcome;
