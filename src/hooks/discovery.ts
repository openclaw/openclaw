// Hook metadata discovery shared by runtime loading and plugin inspection.
import fs from "node:fs";
import path from "node:path";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { parseFrontmatterBlockResult } from "../../packages/markdown-core/src/frontmatter.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";
import { resolveHookInvocationPolicy, resolveHookManifestMetadata } from "./frontmatter.js";
import type { Hook, HookEntry, HookSource } from "./types.js";

// Hook descriptors are small metadata. Bounding the pinned descriptor read also
// covers files that grow after the boundary open validates their identity.
const HOOK_METADATA_MAX_BYTES = 1024 * 1024;

type HookDiscoveryWarning = (message: string) => void;

export type DiscoveredHookEntry = Omit<HookEntry, "hook"> & {
  hook: Omit<Hook, "handlerPath"> & { handlerPath?: string };
  invalidMetadata?: boolean;
};

export type HookDiscoveryRoot = {
  dir: string;
  source: HookSource;
  pluginId?: string;
  rootDir?: string;
  includeRoot?: boolean;
};

function readHookPackagePaths(dir: string, warn?: HookDiscoveryWarning): string[] {
  const manifestPath = path.join(dir, "package.json");
  const raw = readRootFileUtf8(
    {
      absolutePath: manifestPath,
      rootPath: dir,
      boundaryLabel: "hook package directory",
      maxBytes: HOOK_METADATA_MAX_BYTES,
    },
    warn,
  );
  const manifest = raw === null ? undefined : asOptionalObjectRecord(safeParseJson(raw));
  return normalizeTrimmedStringList(asOptionalObjectRecord(manifest?.[MANIFEST_KEY])?.hooks);
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

function loadHookFromDir(
  params: { hookDir: string; source: HookSource; pluginId?: string },
  warn?: HookDiscoveryWarning,
): DiscoveredHookEntry | null {
  const hookMdPath = path.join(params.hookDir, "HOOK.md");
  const content = readRootFileUtf8(
    {
      absolutePath: hookMdPath,
      rootPath: params.hookDir,
      boundaryLabel: "hook directory",
      maxBytes: HOOK_METADATA_MAX_BYTES,
    },
    warn,
  );
  if (content === null) {
    return null;
  }
  try {
    const { frontmatter, issues } = parseFrontmatterBlockResult(content);

    const name = frontmatter.name || path.basename(params.hookDir);
    const description = frontmatter.description || "";

    const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
    let handlerPath: string | undefined;
    for (const candidate of handlerCandidates) {
      const candidatePath = path.join(params.hookDir, candidate);
      const safeCandidatePath = resolveRootFilePath({
        absolutePath: candidatePath,
        rootPath: params.hookDir,
        boundaryLabel: "hook directory",
      });
      if (safeCandidatePath) {
        handlerPath = safeCandidatePath;
        break;
      }
    }

    if (!handlerPath) {
      warn?.(`Hook "${name}" has HOOK.md but no readable handler in ${params.hookDir}`);
    }

    let baseDir = params.hookDir;
    try {
      baseDir = fs.realpathSync.native(params.hookDir);
    } catch {
      // keep the discovered path when realpath is unavailable
    }

    return {
      hook: {
        name,
        description,
        source: params.source,
        pluginId: params.pluginId,
        filePath: hookMdPath,
        baseDir,
        handlerPath,
      },
      frontmatter,
      invalidMetadata: issues.length > 0,
      metadata: resolveHookManifestMetadata(frontmatter),
      invocation: resolveHookInvocationPolicy(frontmatter),
    };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    warn?.(`Failed to load hook from ${params.hookDir}: ${message}`);
    return null;
  }
}

function loadHooksFromCandidate(
  params: { hookDir: string; source: HookSource; pluginId?: string },
  warn?: HookDiscoveryWarning,
): DiscoveredHookEntry[] | null {
  const { hookDir, source, pluginId } = params;
  const packageHooks = readHookPackagePaths(hookDir, warn);
  if (packageHooks.length === 0) {
    if (!fs.existsSync(path.join(hookDir, "HOOK.md"))) {
      return null;
    }
    const hook = loadHookFromDir(params, warn);
    return hook ? [hook] : [];
  }

  const hooks: DiscoveredHookEntry[] = [];
  for (const hookPath of packageHooks) {
    const resolvedHookDir = resolveContainedDir(hookDir, hookPath);
    if (!resolvedHookDir) {
      warn?.(
        `Ignoring out-of-package hook path "${hookPath}" in ${hookDir} (must be within package directory)`,
      );
      continue;
    }
    // Pack entries are hook leaves, never another pack or a collection to scan.
    const hook = loadHookFromDir({ hookDir: resolvedHookDir, source, pluginId }, warn);
    if (hook) {
      hooks.push(hook);
    }
  }

  return hooks;
}

export function loadHookEntriesFromDir(
  params: HookDiscoveryRoot,
  warn?: HookDiscoveryWarning,
): DiscoveredHookEntry[] {
  const { dir, source, pluginId } = params;
  // Plugin policy selects roots even when their files disappear. Boundary checks
  // belong to discovery, so atomic reload can retain the selected source fact.
  if (params.rootDir && !isPathInsideWithRealpath(params.rootDir, dir, { requireRealpath: true })) {
    warn?.(`Plugin hook path is missing or escapes plugin root (${pluginId}): ${dir}`);
    return [];
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  const rootHooks = params.includeRoot
    ? loadHooksFromCandidate({ hookDir: dir, source, pluginId }, warn)
    : null;
  // null means a collection. A recognized root with rejected hooks stays empty;
  // falling back to children would execute code its manifest did not select.
  return (
    rootHooks ??
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) {
        return [];
      }
      return (
        loadHooksFromCandidate({ hookDir: path.join(dir, entry.name), source, pluginId }, warn) ??
        []
      );
    })
  );
}

function readRootFileUtf8(
  params: { absolutePath: string; rootPath: string; boundaryLabel: string; maxBytes: number },
  warn?: HookDiscoveryWarning,
): string | null {
  return withOpenedRootFileSync(params, (opened) => {
    try {
      return readFileDescriptorBoundedSync(opened.fd, params.maxBytes).toString("utf-8");
    } catch (err) {
      if (err instanceof RangeError) {
        warn?.(
          `Ignoring oversized hook metadata ${params.absolutePath}: file exceeds the ${params.maxBytes}-byte limit`,
        );
      }
      return null;
    }
  });
}

function withOpenedRootFileSync<T>(
  params: {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
  },
  read: (opened: { fd: number; path: string }) => T,
): T | null {
  const opened = openRootFileSync({
    absolutePath: params.absolutePath,
    rootPath: params.rootPath,
    boundaryLabel: params.boundaryLabel,
    // Operator hook dirs are commonly symlinked; fs-safe still rejects hops
    // whose canonical target escapes the hook root.
    rejectSymlinks: false,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    return read({ fd: opened.fd, path: opened.path });
  } finally {
    fs.closeSync(opened.fd);
  }
}

function resolveRootFilePath(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
}): string | null {
  return withOpenedRootFileSync(params, (opened) => opened.path);
}
