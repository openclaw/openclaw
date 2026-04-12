import fs from "node:fs/promises";
import path from "node:path";

export async function readPackageVersion(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    const version = parsed?.version?.trim();
    return version ? version : null;
  } catch {
    return null;
  }
}

export async function readPackageName(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: string };
    const name = parsed?.name?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

export async function readPackageBin(root: string): Promise<Record<string, string> | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: string; bin?: unknown };
    const bin = parsed?.bin;
    if (!bin) {
      return null;
    }
    // npm allows bin to be a string shorthand for { "<name>": "<path>" }
    if (typeof bin === "string") {
      const name = parsed?.name?.trim();
      if (!name) return null;
      return { [name]: bin };
    }
    if (typeof bin !== "object" || Array.isArray(bin)) {
      return null;
    }
    return bin as Record<string, string>;
  } catch {
    return null;
  }
}
