import type { z } from "zod";
import type {
  PluginUpdateIntegrityDriftParams,
  PluginUpdateSummary,
} from "../plugins/update-source.js";
import type { LocalPackageOverridesResult } from "./package-local-overrides.js";
import type { UpdateFailureFact } from "./update-failure-facts.js";
import type { GitRuntimeArtifactIdentity } from "./update-git-runtime.js";
import type { UpdateRecovery } from "./update-recovery.js";
import type { UpdateRollbackOutcome, UpdateRunRecordSchema } from "./update-run-schema.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type UpdateRunResult = {
  localOverrides?: LocalPackageOverridesResult;
  runId?: string;
  status: "ok" | "error" | "skipped";
  mode: "git" | "pnpm" | "bun" | "npm" | "unknown";
  root?: string;
  reason?: string;
  /** The executing owner's terminal failure; steps also retain superseded attempts. */
  failedStep?: UpdateStepResult;
  gitRuntime?: GitRuntimeArtifactIdentity;
  before?: { sha?: string | null; version?: string | null; buildId?: string | null };
  after?: {
    sha?: string | null;
    version?: string | null;
    buildId?: string | null;
    upstreamRef?: string;
  };
  steps: UpdateStepResult[];
  durationMs: number;
  recovery?: UpdateRecovery;
  verification?: Omit<
    z.infer<typeof UpdateRunRecordSchema>["verification"],
    "recovery" | "rollbackOutcome"
  >;
  rollbackOutcome?: UpdateRollbackOutcome;
  postUpdate?: {
    plugins?: {
      failureFacts?: UpdateFailureFact[];
      doctorLint?: UpdateStepResult;
      status: "ok" | "warning" | "skipped" | "error";
      reason?: string;
      changed: boolean;
      warnings?: Array<{
        pluginId?: string;
        source?: string;
        errorCode?: string;
        reason: string;
        message: string;
        guidance: string[];
      }>;
      sync: {
        changed: boolean;
        switchedToBundled: string[];
        switchedToNpm: string[];
        warnings: string[];
        errors: string[];
      };
      npm: Pick<PluginUpdateSummary, "changed" | "outcomes">;
      integrityDrifts: Array<
        Omit<PluginUpdateIntegrityDriftParams, "dryRun"> & { action: "aborted" }
      >;
    };
  };
};
