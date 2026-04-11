// Octopus Orchestrator -- `openclaw octo arm logs` CLI command
//
// Retrieves and displays arm output artifacts (stdout, stderr, logs).
// Reads from the artifact store and the output files it references.
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { existsSync, readFileSync } from "node:fs";
import type { ArtifactService } from "../head/artifacts.ts";
import type { RegistryService } from "../head/registry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArmLogsOptions {
  arm_id: string;
  type?: string;
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

export function runArmLogs(
  registry: RegistryService,
  artifacts: ArtifactService,
  opts: ArmLogsOptions,
  out: { write: (s: string) => void } = process.stdout,
  errOut: { write: (s: string) => void } = process.stderr,
): number {
  if (!opts.arm_id || opts.arm_id.trim().length === 0) {
    errOut.write("Error: arm_id is required\n");
    return 1;
  }

  const arm = registry.getArm(opts.arm_id);
  if (arm === null) {
    errOut.write(`Error: arm not found: ${opts.arm_id}\n`);
    return 1;
  }

  const allArtifacts = artifacts.listByArm(opts.arm_id);

  // Filter by type if specified.
  const typeFilter = opts.type;
  const filtered = typeFilter
    ? allArtifacts.filter((a) => a.artifact_type === typeFilter)
    : allArtifacts.filter(
        (a) =>
          a.artifact_type === "stdout-slice" ||
          a.artifact_type === "stderr-slice" ||
          a.artifact_type === "log",
      );

  if (filtered.length === 0) {
    if (opts.json) {
      out.write(JSON.stringify({ arm_id: opts.arm_id, artifacts: [], content: null }) + "\n");
    } else {
      out.write(`No log artifacts found for arm ${opts.arm_id}.\n`);
      out.write(`Arm state: ${arm.state}, adapter: ${arm.adapter_type}\n`);
      if (arm.adapter_type === "pty_tmux" && arm.state !== "completed" && arm.state !== "failed") {
        out.write(
          `Tip: arm is still running — use \`octo arm attach ${opts.arm_id}\` to view live output.\n`,
        );
      }
    }
    return 0;
  }

  if (opts.json) {
    const entries = filtered.map((a) => {
      let content: string | null = null;
      if (existsSync(a.storage_ref)) {
        content = readFileSync(a.storage_ref, "utf-8");
      }
      return {
        artifact_id: a.artifact_id,
        artifact_type: a.artifact_type,
        storage_ref: a.storage_ref,
        created_at: a.created_at,
        content,
      };
    });
    out.write(JSON.stringify({ arm_id: opts.arm_id, artifacts: entries }) + "\n");
    return 0;
  }

  // Human-readable output — concatenate all log content.
  for (const artifact of filtered) {
    const label = artifact.artifact_type.toUpperCase();
    const ts = new Date(artifact.created_at).toISOString();
    out.write(`── ${label} (${ts}) ──────────────────────────────────\n`);

    if (existsSync(artifact.storage_ref)) {
      const content = readFileSync(artifact.storage_ref, "utf-8");
      out.write(content);
      if (!content.endsWith("\n")) {
        out.write("\n");
      }
    } else {
      out.write(`[file not found: ${artifact.storage_ref}]\n`);
    }
    out.write("\n");
  }

  return 0;
}
