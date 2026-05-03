import fs from "node:fs";
import path from "node:path";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

// The marker substring in symlink targets we expect to find for the obsolete
// bundled-plugin runtime layout. Aligns with the constant of the same name in
// scripts/postinstall-bundled-plugins.mjs.
const PLUGIN_RUNTIME_DEPS_MARKER = "plugin-runtime-deps";

// Cap how many entries we list inline in the doctor note so the output stays
// glanceable even on installs with many plugin extension scopes.
const MAX_REPORTED = 6;

interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface StatsLike {
  isSymbolicLink(): boolean;
}

export interface StalePluginRuntimeSymlinksFs {
  readdirSync(dir: string, options: { withFileTypes: true }): readonly DirentLike[];
  lstatSync(file: string): StatsLike;
  readlinkSync(file: string): string;
  statSync(file: string): unknown;
}

export interface NoteStalePluginRuntimeSymlinksOptions {
  readonly fs?: StalePluginRuntimeSymlinksFs;
  readonly noteFn?: (message: string, title?: string) => void;
  readonly shortenPath?: (value: string) => string;
}

interface StaleEntry {
  readonly name: string;
  readonly target: string;
}

const DEFAULT_FS: StalePluginRuntimeSymlinksFs = {
  readdirSync: (dir, options) => fs.readdirSync(dir, options) as unknown as DirentLike[],
  lstatSync: (file) => fs.lstatSync(file),
  readlinkSync: (file) => fs.readlinkSync(file),
  statSync: (file) => fs.statSync(file),
};

/**
 * Detect plugin-runtime symlinks under the global Node prefix that point at
 * pruned `plugin-runtime-deps` directories from a previous OpenClaw install.
 *
 * Background: pre-2026.5.x packaged installs created `@scope/<pkg>` symlinks
 * inside the global Node prefix's `node_modules/` that targeted a versioned
 * `~/.openclaw<profile>/plugin-runtime-deps/openclaw-<version>/...` runtime tree.
 * The 2026.5.x postinstall removes those state directories on upgrade, leaving
 * the global symlinks dangling. ESM imports from bundled extensions (such as
 * the Slack channel client) then fail with `ERR_MODULE_NOT_FOUND` even though
 * the package name resolves to a valid path on disk.
 *
 * This check is read-only: it surfaces the dangling links so users can repair
 * them by running `openclaw doctor --fix` (where the matching repair lives in
 * a follow-up change) or by reinstalling OpenClaw, instead of staring at an
 * opaque ESM resolution error from a cron-fired channel turn.
 */
export function noteStalePluginRuntimeSymlinks(
  packageRoot: string | null,
  options: NoteStalePluginRuntimeSymlinksOptions = {},
): void {
  if (!packageRoot) {
    return;
  }
  const fsApi = options.fs ?? DEFAULT_FS;
  const noteFn = options.noteFn ?? note;
  const shortenPath = options.shortenPath ?? shortenHomePath;

  const containingNodeModules = path.dirname(packageRoot);
  if (path.basename(containingNodeModules) !== "node_modules") {
    return;
  }

  const stale: StaleEntry[] = [];

  let entries: readonly DirentLike[];
  try {
    entries = fsApi.readdirSync(containingNodeModules, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      const scopeDir = path.join(containingNodeModules, entry.name);
      let scopeEntries: readonly DirentLike[];
      try {
        scopeEntries = fsApi.readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopeEntry of scopeEntries) {
        const fullPath = path.join(scopeDir, scopeEntry.name);
        const result = inspectCandidate(fullPath, fsApi);
        if (result) {
          stale.push({ name: `${entry.name}/${scopeEntry.name}`, target: result });
        }
      }
    } else if (entry.isSymbolicLink()) {
      const fullPath = path.join(containingNodeModules, entry.name);
      const result = inspectCandidate(fullPath, fsApi);
      if (result) {
        stale.push({ name: entry.name, target: result });
      }
    }
  }

  if (stale.length === 0) {
    return;
  }

  const lines: string[] = [
    "- Plugin-runtime symlinks under the global Node prefix point at pruned",
    `  ${PLUGIN_RUNTIME_DEPS_MARKER} directories from a previous OpenClaw install.`,
    "- Bundled extension ESM imports (e.g. channel clients) will fail with",
    "  ERR_MODULE_NOT_FOUND on the next cron or interactive run until repaired.",
  ];
  const reported = stale.slice(0, MAX_REPORTED);
  for (const item of reported) {
    lines.push(`  - ${item.name} -> ${shortenPath(item.target)}`);
  }
  if (stale.length > reported.length) {
    lines.push(`  - …and ${stale.length - reported.length} more`);
  }
  lines.push("- Repair: remove the dangling symlinks and reinstall OpenClaw,");
  lines.push("  or rerun `openclaw doctor --fix` once the matching repair lands.");

  noteFn(lines.join("\n"), "Plugin-runtime symlinks");
}

function inspectCandidate(fullPath: string, fsApi: StalePluginRuntimeSymlinksFs): string | null {
  let stats: StatsLike;
  try {
    stats = fsApi.lstatSync(fullPath);
  } catch {
    return null;
  }
  if (!stats.isSymbolicLink()) {
    return null;
  }
  let target: string;
  try {
    target = fsApi.readlinkSync(fullPath);
  } catch {
    return null;
  }
  if (!target.includes(PLUGIN_RUNTIME_DEPS_MARKER)) {
    return null;
  }
  const resolvedTarget = path.isAbsolute(target)
    ? target
    : path.resolve(path.dirname(fullPath), target);

  try {
    fsApi.statSync(resolvedTarget);
    return null;
  } catch {
    return resolvedTarget;
  }
}
