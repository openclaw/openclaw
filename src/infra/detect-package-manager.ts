import fs from "node:fs/promises";
import { readPackageManagerSpec } from "./package-json.js";

type DetectedPackageManager = "pnpm" | "bun" | "npm";

/** Detects the package manager a project expects from package.json or lockfiles. */
export async function detectPackageManager(root: string): Promise<DetectedPackageManager | null> {
  const pm = (await readPackageManagerSpec(root))?.split("@")[0]?.trim();
  if (pm === "pnpm" || pm === "bun" || pm === "npm") {
    return pm;
  }

  // packageManager is authoritative only for supported managers; otherwise
  // lockfiles preserve setup behavior for projects using unsupported values.
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
