import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { UpdateCandidateBundledSource } from "./update-candidate-plugins.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import type { UpdateRunStep } from "./update-run-record.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type UpdateCanaryTarget = { kind: "cli"; entryPath: string } | { kind: "worker"; url: URL };

export type UpdateCanaryCommand = {
  phase: "doctor" | "lint" | "config" | "plugins" | "runtime";
  name: string;
  args: string[];
  target?: UpdateCanaryTarget;
};

export function buildUpdateCanaryCommands(params: {
  continuationEntry: URL;
  migrationPolicy?: "rehearse" | "startup-only";
  fullIntegrityCheck?: boolean;
}): UpdateCanaryCommand[] {
  const runtime: UpdateCanaryCommand = {
    phase: "runtime",
    name: "candidate-recovery",
    // After a schema bump only a fresh candidate may finalize the run;
    // prove its full recovery import graph before live state changes.
    target: { kind: "worker", url: params.continuationEntry },
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
} & CanaryOutcome;

export type UpdateCandidateCanaryParams = {
  root: string;
  /** Serving updater's discovery, not the staged worker's package. */
  sourceBundledPlugins?: UpdateCandidateBundledSource;
  config: OpenClawConfig;
  stateDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  nodeRunner?: string;
  /** Serving runtime for Gateway startup only; maintenance keeps nodeRunner. */
  gatewayStartupRuntime?: string;
  fullIntegrityCheck?: boolean;
  assertCurrent?: () => void;
  /** Startup-only callers must prove the preserved input boots without Doctor repair. */
  migrationPolicy?: "rehearse" | "startup-only";
  /** Emit at completion; replaying after the canary shifts persisted step timestamps. */
  onStep?: (step: UpdateStepResult) => void | Promise<void>;
  onProgress?: (step: UpdateRunStep) => void | Promise<void>;
};
