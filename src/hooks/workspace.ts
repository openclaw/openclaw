import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { resolveBundledHooksDir } from "./bundled-dir.js";
import { shouldIncludeHook } from "./config.js";
import {
  parseFrontmatter,
  resolveOpenClawMetadata,
  resolveHookInvocationPolicy,
} from "./frontmatter.js";
import type {
  Hook,
  HookEligibilityContext,
  HookEntry,
  HookSnapshot,
  HookSource,
  ParsedHookFrontmatter,
} from "./types.js";

type HookPackageManifest = {
  name?: string;
} & Partial<Record<typeof MANIFEST_KEY, { hooks?: string[] }>>;
const log = createSubsystemLogger("hooks/workspace");

function filterHookEntries(
  entries: HookEntry[],
  config?: OpenClawConfig,
  eligibility?: HookEligibilityContext,
): HookEntry[] {
  return entries.filter((entry) => shouldIncludeHook({ entry, config, eligibility }));
}

function readHookPackageManifest(dir: string): HookPackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as HookPackageManifest;
  } catch {
    return null;
  }
}

function resolvePackageHooks(manifest: HookPackageManifest): string[] {
  const raw = manifest[MANIFEST_KEY]?.hooks;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function resolveContainedDir(baseDir: string, targetDir: string): string | null {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, targetDir);
  if (
    !isPathInsideWithRealpath(base, resolved, {
      requireRealpath: true,
    })
  ) {
    return null;
  }
  return resolved;
}

function loadHookFromDir(params: {
  hookDir: string;
  source: HookSource;
  pluginId?: string;
  nameHint?: string;
}): Hook | null {
  const hookMdPath = path.join(params.hookDir, "HOOK.md");
  if (!fs.existsSync(hookMdPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(hookMdPath, "utf-8");
    const frontmatter = parseFrontmatter(content);

    const name = frontmatter.name || params.nameHint || path.basename(params.hookDir);
    const description = frontmatter.description || "";

    const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
    let handlerPath: string | undefined;
    for (const candidate of handlerCandidates) {
      const candidatePath = path.join(params.hookDir, candidate);
      if (fs.existsSync(candidatePath)) {
        handlerPath = candidatePath;
        break;
      }
    }

    if (!handlerPath) {
      log.warn(`Hook "${name}" has HOOK.md but no handler file in ${params.hookDir}`);
      return null;
    }

    return {
      name,
      description,
      source: params.source,
      pluginId: params.pluginId,
      filePath: hookMdPath,
      baseDir: params.hookDir,
      handlerPath,
    };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.warn(`Failed to load hook from ${params.hookDir}: ${message}`);
    return null;
  }
}

/**
 * Scan a directory for hooks (subdirectories containing HOOK.md)
 */
function loadHooksFromDir(params: { dir: string; source: HookSource; pluginId?: string }): Hook[] {
  const { dir, source, pluginId } = params;

  if (!fs.existsSync(dir)) {
    return [];
  }

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    return [];
  }

  const hooks: Hook[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const hookDir = path.join(dir, entry.name);
    const manifest = readHookPackageManifest(hookDir);
    const packageHooks = manifest ? resolvePackageHooks(manifest) : [];

    if (packageHooks.length > 0) {
      for (const hookPath of packageHooks) {
        const resolvedHookDir = resolveContainedDir(hookDir, hookPath);
        if (!resolvedHookDir) {
          log.warn(
            `Ignoring out-of-package hook path "${hookPath}" in ${hookDir} (must be within package directory)`,
          );
          continue;
        }
        const hook = loadHookFromDir({
          hookDir: resolvedHookDir,
          source,
          pluginId,
          nameHint: path.basename(resolvedHookDir),
        });
        if (hook) {
          hooks.push(hook);
        }
      }
      continue;
    }

    const hook = loadHookFromDir({
      hookDir,
      source,
      pluginId,
      nameHint: entry.name,
    });
    if (hook) {
      hooks.push(hook);
    }
  }

  return hooks;
}

export function loadHookEntriesFromDir(params: {
  dir: string;
  source: HookSource;
  pluginId?: string;
}): HookEntry[] {
  const hooks = loadHooksFromDir({
    dir: params.dir,
    source: params.source,
    pluginId: params.pluginId,
  });
  return hooks.map((hook) => {
    let frontmatter: ParsedHookFrontmatter = {};
    try {
      const raw = fs.readFileSync(hook.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // ignore malformed hooks
    }
    const entry: HookEntry = {
      hook: {
        ...hook,
        source: params.source,
        pluginId: params.pluginId,
      },
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveHookInvocationPolicy(frontmatter),
    };
    return entry;
  });
}

function loadHookEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
  },
): HookEntry[] {
  const managedHooksDir = opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks");
  const workspaceHooksDir = path.join(workspaceDir, "hooks");
  const bundledHooksDir = opts?.bundledHooksDir ?? resolveBundledHooksDir();
  const extraDirsRaw = opts?.config?.hooks?.internal?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);

  const bundledHooks = bundledHooksDir
    ? loadHooksFromDir({
        dir: bundledHooksDir,
        source: "openclaw-bundled",
      })
    : [];
  const extraHooks = extraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadHooksFromDir({
      dir: resolved,
      source: "openclaw-workspace", // Extra dirs treated as workspace
    });
  });
  const managedHooks = loadHooksFromDir({
    dir: managedHooksDir,
    source: "openclaw-managed",
  });
  const workspaceHooks = loadHooksFromDir({
    dir: workspaceHooksDir,
    source: "openclaw-workspace",
  });

  const merged = new Map<string, Hook>();
  // Precedence: extra < bundled < managed < workspace (workspace wins)
  for (const hook of extraHooks) {
    merged.set(hook.name, hook);
  }
  for (const hook of bundledHooks) {
    merged.set(hook.name, hook);
  }
  for (const hook of managedHooks) {
    merged.set(hook.name, hook);
  }
  for (const hook of workspaceHooks) {
    merged.set(hook.name, hook);
  }

  return Array.from(merged.values()).map((hook) => {
    let frontmatter: ParsedHookFrontmatter = {};
    try {
      const raw = fs.readFileSync(hook.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // ignore malformed hooks
    }
    return {
      hook,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveHookInvocationPolicy(frontmatter),
    };
  });
}

export function buildWorkspaceHookSnapshot(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
    entries?: HookEntry[];
    eligibility?: HookEligibilityContext;
    snapshotVersion?: number;
  },
): HookSnapshot {
  const hookEntries = opts?.entries ?? loadHookEntries(workspaceDir, opts);
  const eligible = filterHookEntries(hookEntries, opts?.config, opts?.eligibility);

  return {
    hooks: eligible.map((entry) => ({
      name: entry.hook.name,
      events: entry.metadata?.events ?? [],
    })),
    resolvedHooks: eligible.map((entry) => entry.hook),
    version: opts?.snapshotVersion,
  };
}

export function loadWorkspaceHookEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedHooksDir?: string;
    bundledHooksDir?: string;
  },
): HookEntry[] {
  return loadHookEntries(workspaceDir, opts);
}
