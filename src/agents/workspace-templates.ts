import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { pathExists } from "../utils.js";

/**
 * Compute fallback template directory candidates relative to a module URL.
 *
 * In the source tree the module lives at `src/agents/workspace-templates.ts`,
 * so `../../docs/reference/templates` resolves correctly to the repo root.
 *
 * After bundling, all files land in `dist/` (one level deep inside the
 * package root), so `../../docs/reference/templates` overshoots by one
 * directory (lands in node_modules/ instead of the package). We include
 * both `../../` (source) and `../` (bundled dist) as fallback candidates
 * to handle either layout.
 */
function computeFallbackTemplateDirs(moduleUrl: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.resolve(moduleDir, "../../docs/reference/templates"), // source layout (src/agents/)
    path.resolve(moduleDir, "../docs/reference/templates"), // bundled layout (dist/)
  ];
}

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
    const fallbackDirs = computeFallbackTemplateDirs(moduleUrl);
    const candidates = [
      // Preferred: resolved package root (most reliable)
      packageRoot ? path.join(packageRoot, "docs", "reference", "templates") : null,
      // Fallback: relative to module file (handles both source and bundled layouts)
      ...fallbackDirs,
      // Last resort: relative to cwd (only useful if running from repo checkout)
      cwd ? path.resolve(cwd, "docs", "reference", "templates") : null,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        cachedTemplateDir = candidate;
        return candidate;
      }
    }

    // No candidate exists — return the package-root-based path (or first
    // fallback) so the downstream error message shows a meaningful path.
    cachedTemplateDir = candidates[0] ?? fallbackDirs[0];
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
