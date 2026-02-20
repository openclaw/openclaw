import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { pathExists } from "../utils.js";

const TEMPLATE_SUBPATH = path.join("docs", "reference", "templates");

/**
 * Walk up from a starting directory to find a parent that contains the
 * templates directory.  This handles both the source layout (`src/agents/`)
 * and the bundled layout (`dist/`) where the relative depth differs.
 */
function findTemplateDirFromAncestors(startDir: string, maxDepth = 6): string | null {
  let current = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(current, TEMPLATE_SUBPATH);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // not found at this level, keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

const FALLBACK_TEMPLATE_DIR =
  findTemplateDirFromAncestors(path.dirname(fileURLToPath(import.meta.url))) ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", TEMPLATE_SUBPATH);

let cachedTemplateDir: string | undefined;
let resolvingTemplateDir: Promise<string> | undefined;

export async function resolveWorkspaceTemplateDir(opts?: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string> {
  if (cachedTemplateDir) {
    return cachedTemplateDir;
  }
  if (resolvingTemplateDir) {
    return resolvingTemplateDir;
  }

  resolvingTemplateDir = (async () => {
    const moduleUrl = opts?.moduleUrl ?? import.meta.url;
    const argv1 = opts?.argv1 ?? process.argv[1];
    const cwd = opts?.cwd ?? process.cwd();

    const packageRoot = await resolveOpenClawPackageRoot({ moduleUrl, argv1, cwd });
    const candidates = [
      packageRoot ? path.join(packageRoot, "docs", "reference", "templates") : null,
      cwd ? path.resolve(cwd, "docs", "reference", "templates") : null,
      FALLBACK_TEMPLATE_DIR,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        cachedTemplateDir = candidate;
        return candidate;
      }
    }

    cachedTemplateDir = candidates[0] ?? FALLBACK_TEMPLATE_DIR;
    return cachedTemplateDir;
  })();

  try {
    return await resolvingTemplateDir;
  } finally {
    resolvingTemplateDir = undefined;
  }
}

export function resetWorkspaceTemplateDirCache() {
  cachedTemplateDir = undefined;
  resolvingTemplateDir = undefined;
}
