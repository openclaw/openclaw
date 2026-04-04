/**
 * Workspace gating — checks if Meta-Harness is enabled for a workspace.
 *
 * Meta-Harness is only active when `data/meta-harness/manifest.json` exists
 * in the workspace directory. Otherwise, all trace operations are no-ops.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { GatingResult, MetaHarnessManifest } from "./types.js";

const MANIFEST_RELATIVE = "data/meta-harness/manifest.json";

/**
 * Check if Meta-Harness is enabled for the given workspace directory.
 */
export async function checkWorkspaceGating(workspaceDir: string): Promise<GatingResult> {
  const manifestPath = path.join(workspaceDir, MANIFEST_RELATIVE);
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const manifest: MetaHarnessManifest = JSON.parse(raw);
    return { enabled: true, manifest };
  } catch {
    return { enabled: false, reason: "manifest not found or invalid" };
  }
}

/**
 * Initialize the Meta-Harness runtime layout for a workspace.
 * Creates required directories and manifest if not present.
 *
 * @returns true if layout was created or already existed, false on error.
 */
export async function ensureRuntimeLayout(workspaceDir: string): Promise<boolean> {
  const dirs = [
    "data/meta-harness/traces",
    "data/meta-harness/children",
    "data/meta-harness/rich",
    "data/meta-harness/daily",
    "data/meta-harness/weekly",
    "data/meta-harness/indexes",
  ];

  for (const rel of dirs) {
    const abs = path.join(workspaceDir, rel);
    try {
      await fs.mkdir(abs, { recursive: true });
    } catch {
      return false;
    }
  }

  // Create manifest if missing
  const manifestPath = path.join(workspaceDir, MANIFEST_RELATIVE);
  try {
    await fs.access(manifestPath);
  } catch {
    const manifest: MetaHarnessManifest = {
      version: "1.0.0",
      created_at: new Date().toISOString(),
      workspace_path: workspaceDir,
    };
    try {
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    } catch {
      return false;
    }
  }

  return true;
}
