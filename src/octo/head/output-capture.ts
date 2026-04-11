// Octopus Orchestrator -- Output capture service
//
// Persists arm stdout/stderr as artifact records with content written
// to durable files. Bridges the adapter output streams with the
// artifact store for post-mortem inspection.
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactService, ArtifactType } from "./artifacts.ts";

// ──────────────────────────────────────────────────────────────────────────
// Output directory convention
// ──────────────────────────────────────────────────────────────────────────

const OUTPUT_SUBDIR = "octo/arm-output";

function resolveOutputDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(home, ".openclaw");
  return join(stateDir, OUTPUT_SUBDIR);
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export interface CaptureOutputOptions {
  arm_id: string;
  mission_id: string;
  grip_id?: string;
  stdout?: string;
  stderr?: string;
}

/**
 * Write arm stdout/stderr to durable files and record as artifacts.
 * Idempotent — safe to call multiple times for the same arm.
 */
export async function captureArmOutput(
  artifacts: ArtifactService,
  opts: CaptureOutputOptions,
): Promise<{ stdoutRef?: string; stderrRef?: string }> {
  const outputDir = join(resolveOutputDir(), opts.arm_id);
  mkdirSync(outputDir, { recursive: true });

  const result: { stdoutRef?: string; stderrRef?: string } = {};

  if (opts.stdout !== undefined && opts.stdout.length > 0) {
    const stdoutPath = join(outputDir, "stdout.log");
    writeFileSync(stdoutPath, opts.stdout, "utf-8");
    result.stdoutRef = stdoutPath;

    await artifacts.record({
      artifact_type: "stdout-slice" as ArtifactType,
      mission_id: opts.mission_id,
      grip_id: opts.grip_id ?? null,
      arm_id: opts.arm_id,
      storage_ref: stdoutPath,
      metadata: { bytes: Buffer.byteLength(opts.stdout, "utf-8") },
    });
  }

  if (opts.stderr !== undefined && opts.stderr.length > 0) {
    const stderrPath = join(outputDir, "stderr.log");
    writeFileSync(stderrPath, opts.stderr, "utf-8");
    result.stderrRef = stderrPath;

    await artifacts.record({
      artifact_type: "stderr-slice" as ArtifactType,
      mission_id: opts.mission_id,
      grip_id: opts.grip_id ?? null,
      arm_id: opts.arm_id,
      storage_ref: stderrPath,
      metadata: { bytes: Buffer.byteLength(opts.stderr, "utf-8") },
    });
  }

  return result;
}

/**
 * Capture tmux pane content for a pty_tmux arm. Reads the final state
 * of the tmux pane and persists it as a log artifact.
 */
export async function captureTmuxPaneOutput(
  artifacts: ArtifactService,
  opts: {
    arm_id: string;
    mission_id: string;
    grip_id?: string;
    paneContent: string;
  },
): Promise<string | undefined> {
  if (!opts.paneContent || opts.paneContent.trim().length === 0) {
    return undefined;
  }

  const outputDir = join(resolveOutputDir(), opts.arm_id);
  mkdirSync(outputDir, { recursive: true });

  const logPath = join(outputDir, "pane-capture.log");
  writeFileSync(logPath, opts.paneContent, "utf-8");

  await artifacts.record({
    artifact_type: "log" as ArtifactType,
    mission_id: opts.mission_id,
    grip_id: opts.grip_id ?? null,
    arm_id: opts.arm_id,
    storage_ref: logPath,
    metadata: {
      source: "tmux-capture-pane",
      bytes: Buffer.byteLength(opts.paneContent, "utf-8"),
    },
  });

  return logPath;
}
