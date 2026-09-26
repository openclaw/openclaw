// Doctor detection and cleanup for stale global plugin-runtime symlinks.
import fs from "node:fs/promises";
import path from "node:path";
import { walkDirectory } from "@openclaw/fs-safe/walk";
import { note } from "../../../../packages/terminal-core/src/note.js";
import type { HealthFinding } from "../../../flows/health-checks.js";
import { resolveOpenClawPackageRootSync } from "../../../infra/openclaw-root.js";
import { shortenHomePath } from "../../../utils.js";

const PLUGIN_RUNTIME_DEPS_MARKER = "plugin-runtime-deps";
const MAX_REPORTED = 6;

interface StalePluginRuntimeSymlink {
  /** Package or scoped package name for the stale symlink. */
  readonly name: string;
  /** Symlink path under the containing node_modules directory. */
  readonly path: string;
  /** Target recorded by the symlink, for diagnostic output. */
  readonly target: string;
}

/** Find global node_modules symlinks that still point at stale plugin-runtime deps. */
async function collectStalePluginRuntimeSymlinks(
  packageRoot: string | null = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  }),
): Promise<StalePluginRuntimeSymlink[]> {
  if (!packageRoot) {
    return [];
  }
  const containingNodeModules = path.dirname(packageRoot);
  if (path.basename(containingNodeModules) !== "node_modules") {
    return [];
  }

  const stale: StalePluginRuntimeSymlink[] = [];
  const { entries } = await walkDirectory(containingNodeModules, {
    maxDepth: 2,
    symlinks: "include",
    include: (entry) => entry.kind === "symlink",
    descend: (entry) => entry.depth === 1 && entry.name.startsWith("@"),
  });
  for (const entry of entries) {
    const target = await inspectCandidate(entry.path);
    if (target) {
      stale.push({
        name: entry.relativePath.split(path.sep).join("/"),
        path: entry.path,
        target,
      });
    }
  }

  return stale.toSorted((left, right) => left.name.localeCompare(right.name));
}

function stalePluginRuntimeSymlinkToHealthFinding(item: StalePluginRuntimeSymlink): HealthFinding {
  return {
    checkId: "core/doctor/stale-plugin-runtime-symlinks",
    severity: "warning",
    message: `Stale plugin-runtime symlink ${item.name} points at ${item.target}.`,
    path: item.path,
    target: item.path,
    requirement: "stale-plugin-runtime-symlink-removed",
    fixHint: "Run `openclaw doctor --fix` to remove stale plugin-runtime symlinks.",
  };
}

export async function collectStalePluginRuntimeSymlinkHealthFindings(
  params: { packageRoot?: string | null } = {},
): Promise<HealthFinding[]> {
  return (await collectStalePluginRuntimeSymlinks(params.packageRoot)).map(
    stalePluginRuntimeSymlinkToHealthFinding,
  );
}

/** Emit a doctor note describing stale plugin-runtime symlinks, if any exist. */
export async function noteStalePluginRuntimeSymlinks(
  packageRoot: string | null | undefined,
): Promise<void> {
  const stale = await collectStalePluginRuntimeSymlinks(packageRoot);
  if (stale.length === 0) {
    return;
  }

  const lines = [
    "- Plugin-runtime symlinks under the global Node prefix point at pruned",
    `  ${PLUGIN_RUNTIME_DEPS_MARKER} directories from a previous OpenClaw install.`,
    "- Bundled plugin ESM imports can fail with ERR_MODULE_NOT_FOUND until repaired.",
  ];
  for (const item of stale.slice(0, MAX_REPORTED)) {
    lines.push(`  - ${item.name} -> ${shortenHomePath(item.target)}`);
  }
  if (stale.length > MAX_REPORTED) {
    lines.push(`  - ...and ${stale.length - MAX_REPORTED} more`);
  }
  lines.push("- Repair: run `openclaw doctor --fix` to remove the dangling symlinks.");
  note(lines.join("\n"), "Plugin-runtime symlinks");
}

/** Remove stale plugin-runtime symlinks and report changes/warnings. */
export async function removeStalePluginRuntimeSymlinks(
  packageRoot?: string | null,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const item of await collectStalePluginRuntimeSymlinks(packageRoot)) {
    try {
      await fs.unlink(item.path);
      changes.push(`Removed stale plugin-runtime symlink: ${item.path}`);
    } catch (error) {
      warnings.push(`Failed to remove stale plugin-runtime symlink ${item.path}: ${String(error)}`);
    }
  }
  return { changes, warnings };
}

async function inspectCandidate(fullPath: string): Promise<string | null> {
  const stat = await fs.lstat(fullPath).catch(() => null);
  if (!stat?.isSymbolicLink()) {
    return null;
  }
  const target = await fs.readlink(fullPath).catch(() => null);
  if (!target || !target.includes(PLUGIN_RUNTIME_DEPS_MARKER)) {
    return null;
  }
  // Paths and cache markers cannot authorize removal. Check the alias itself:
  // lexical ".." normalization can erase an intermediate directory symlink
  // and make a live shared-cache target appear missing.
  try {
    await fs.stat(fullPath);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? target : null;
  }
}
