import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { pathExists } from "../utils.js";

/** Filenames that may be read from OPENCLAW_IMMUTABLE_DIR in Docker (image has them chmod 444). */
export const IMMUTABLE_TEMPLATE_FILENAMES: readonly string[] = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "WORKSPACE_RULES.md",
];

const IMMUTABLE_SET = new Set(IMMUTABLE_TEMPLATE_FILENAMES);

function getImmutableDir(): string | undefined {
  const raw = process.env.OPENCLAW_IMMUTABLE_DIR?.trim();
  return raw || undefined;
}

/** If OPENCLAW_IMMUTABLE_DIR is set and the file exists there, return that path; else null. */
export async function resolveImmutableBootstrapPath(
  fileName: string,
): Promise<string | null> {
  const dir = getImmutableDir();
  if (!dir || !IMMUTABLE_SET.has(fileName)) {
    return null;
  }
  const candidate = path.join(dir, fileName);
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

const FALLBACK_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/reference/templates",
);

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
