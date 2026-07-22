// Doctor discovery of sandbox workspace copies for legacy workspace-state repair.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "./home-dir.js";

/**
 * Non-rw sandbox turns use copies under workspaceRoot (default `<stateDir>/sandboxes`),
 * not the configured agent workspace. Runtime asserts against those copies, so Doctor
 * must discover the same roots or the advertised `doctor --fix` recovery path fails.
 */
export function listSandboxWorkspaceCopyDirs(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
}): string[] {
  const roots = new Set<string>();
  roots.add(path.resolve(params.stateDir, "sandboxes"));

  const addConfiguredRoot = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    roots.add(resolveUserPath(trimmed, params.env, params.homedir));
  };

  addConfiguredRoot(params.cfg.agents?.defaults?.sandbox?.workspaceRoot);
  const list = params.cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object") {
        addConfiguredRoot(entry.sandbox?.workspaceRoot);
      }
    }
  }

  const dirs = new Set<string>();
  for (const sandboxRoot of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sandboxRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      // Unreadable sandbox root: skip; configured workspaces remain covered.
      continue;
    }
    // Shared-scope sandbox uses the root itself as the workspace dir.
    dirs.add(sandboxRoot);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      dirs.add(path.join(sandboxRoot, entry.name));
    }
  }
  return [...dirs];
}
