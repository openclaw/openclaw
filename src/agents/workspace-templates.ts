/**
 * Workspace template discovery and loading.
 * Resolves packaged templates and caches their frontmatter-free contents.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { pathExists } from "../utils.js";

const workspaceTemplateCache = new Map<string, Promise<string>>();

const FALLBACK_DOCS_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/reference/templates",
);

/** Resolves existing packaged workspace-template directories without retired runtime paths. */
export async function resolveWorkspaceTemplateSearchDirs(opts?: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string[]> {
  const moduleUrl = opts?.moduleUrl ?? import.meta.url;
  const argv1 = opts?.argv1 ?? process.argv[1];
  const cwd = opts?.cwd ?? process.cwd();

  const packageRoot = await resolveOpenClawPackageRoot({ moduleUrl, argv1, cwd });
  const relativeDir = path.join("docs", "reference", "templates");
  const candidates = [
    packageRoot ? path.join(packageRoot, relativeDir) : undefined,
    path.resolve(cwd, relativeDir),
    FALLBACK_DOCS_TEMPLATE_DIR,
  ];
  const dirs: string[] = [];
  for (const candidate of candidates) {
    if (candidate && !dirs.includes(candidate) && (await pathExists(candidate))) {
      dirs.push(candidate);
    }
  }
  return dirs;
}

function stripFrontMatter(content: string): string {
  return extractFrontmatterBlock(content)?.body.replace(/^\s+/, "") ?? content;
}

/** Loads a packaged template, sharing concurrent reads and evicting failed loads. */
export async function loadWorkspaceTemplate(name: string): Promise<string> {
  const cached = workspaceTemplateCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const templateDirs = await resolveWorkspaceTemplateSearchDirs();
    const triedPaths: string[] = [];
    for (const templateDir of templateDirs) {
      const templatePath = path.join(templateDir, name);
      triedPaths.push(templatePath);
      try {
        const content = await fs.readFile(templatePath, "utf-8");
        return stripFrontMatter(content);
      } catch (error) {
        // SAFETY: Node filesystem errors expose code; other failures lack ENOENT and are rethrown.
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    throw new Error(
      `Missing workspace template: ${name} (${triedPaths.join(", ")}). Ensure workspace templates are packaged.`,
    );
  })();

  workspaceTemplateCache.set(name, pending);
  try {
    return await pending;
  } catch (error) {
    workspaceTemplateCache.delete(name);
    throw error;
  }
}
