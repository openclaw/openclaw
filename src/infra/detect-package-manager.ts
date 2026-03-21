import fs from "node:fs/promises";
import path from "node:path";

export type DetectedPackageManager = "pnpm" | "bun" | "npm";

export async function detectPackageManager(root: string): Promise<DetectedPackageManager | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { packageManager?: string };
    const pm = parsed?.packageManager?.split("@")[0]?.trim();
    if (pm === "pnpm" || pm === "bun" || pm === "npm") {
      return pm;
    }
  } catch {
    // ignore
  }

  const files = await fs.readdir(root).catch((): string[] => []);
  if (files.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (files.includes("bun.lock") || files.includes("bun.lockb")) {
    return "bun";
  }
  if (files.includes("package-lock.json")) {
    return "npm";
  }
  return null;
}

/**
 * Detect the actual global package manager that installed a package,
 * based on the resolved package root path. This is used for `installKind === "package"`
 * to avoid reading `package.json.packageManager` (which reflects the repo's build tool,
 * not the user's install method).
 *
 * Path heuristics:
 * - pnpm global: contains `/.pnpm/` in the resolved path
 * - bun global:  contains `/.bun/` in the resolved path
 * - npm global:  default fallback (npm doesn't add unique path markers)
 */
export function detectGlobalInstallManager(resolvedRoot: string): DetectedPackageManager {
  const normalized = resolvedRoot.split(path.sep).join("/");

  // pnpm global store uses .pnpm/ virtual store layout
  if (normalized.includes("/.pnpm/") || normalized.includes("/pnpm/global/")) {
    return "pnpm";
  }

  // bun global installs live under ~/.bun/
  if (normalized.includes("/.bun/")) {
    return "bun";
  }

  // npm global is the default — it installs into lib/node_modules/<pkg>
  // without distinctive path markers
  return "npm";
}
