import fs from "node:fs/promises";
import { readPackageManagerSpec } from "./package-json.js";

type DetectedPackageManager = "pnpm" | "bun" | "npm";

export async function detectPackageManager(root: string): Promise<DetectedPackageManager | null> {
  const files = await fs.readdir(root).catch((): string[] => []);

  // npm-shrinkwrap.json is the canonical npm published-package lockfile.
  // Check it before the packageManager field so a pnpm development workspace
  // does not misidentify a package that was installed by npm.
  // Guard against a pnpm monorepo that also ships npm-shrinkwrap.json: if
  // pnpm-lock.yaml is present alongside npm-shrinkwrap.json, this is a pnpm
  // development workspace, not an npm-installed package.
  if (files.includes("npm-shrinkwrap.json") && !files.includes("pnpm-lock.yaml")) {
    return "npm";
  }

  const pm = (await readPackageManagerSpec(root))?.split("@")[0]?.trim();
  if (pm === "pnpm" || pm === "bun" || pm === "npm") {
    return pm;
  }

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
