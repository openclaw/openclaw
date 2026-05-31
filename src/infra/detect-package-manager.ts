import fs from "node:fs/promises";
import { readPackageManagerSpec } from "./package-json.js";

type DetectedPackageManager = "pnpm" | "bun" | "npm";

/**
 * Lock files that serve as ground-truth evidence of the package manager
 * actually used to install the package.  npm global installs ship
 * `npm-shrinkwrap.json` rather than `package-lock.json`, so both must be
 * recognised.
 */
const LOCK_FILE_MANAGERS: Array<{ files: readonly string[]; manager: DetectedPackageManager }> = [
  { files: ["pnpm-lock.yaml"], manager: "pnpm" },
  { files: ["bun.lock", "bun.lockb"], manager: "bun" },
  { files: ["package-lock.json", "npm-shrinkwrap.json"], manager: "npm" },
];

export async function detectPackageManager(root: string): Promise<DetectedPackageManager | null> {
  // 1. Lock files are the ground truth — they prove what package manager
  //    was actually used to install.  Check them first so that an npm
  //    global install of a pnpm-authored package (whose package.json
  //    carries "packageManager": "pnpm") still reports "npm".
  const entries = await fs.readdir(root).catch((): string[] => []);
  for (const { files, manager } of LOCK_FILE_MANAGERS) {
    if (files.some((f) => entries.includes(f))) {
      return manager;
    }
  }

  // 2. No lock file — fall back to the package.json declaration.
  const pm = (await readPackageManagerSpec(root))?.split("@")[0]?.trim();
  if (pm === "pnpm" || pm === "bun" || pm === "npm") {
    return pm;
  }

  return null;
}
