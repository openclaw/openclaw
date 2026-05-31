import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { detectPackageManager } from "./detect-package-manager.js";

async function withPackageManagerRoot<T>(
  files: Array<{ path: string; content: string }>,
  run: (root: string) => Promise<T>,
): Promise<T> {
  return await withTempDir({ prefix: "openclaw-detect-pm-" }, async (root) => {
    for (const file of files) {
      await fs.writeFile(path.join(root, file.path), file.content, "utf8");
    }
    return await run(root);
  });
}

describe("detectPackageManager", () => {
  it("prefers lock files over package.json packageManager field", async () => {
    // package.json says pnpm, but an npm lock file is present → npm wins.
    // This protects npm global installs of pnpm-authored packages.
    await withPackageManagerRoot(
      [
        { path: "package.json", content: JSON.stringify({ packageManager: "pnpm@10.8.1" }) },
        { path: "package-lock.json", content: "" },
      ],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBe("npm");
      },
    );
  });

  it("detects npm from npm-shrinkwrap.json without package-lock.json", async () => {
    // npm global installs produce npm-shrinkwrap.json but not package-lock.json.
    await withPackageManagerRoot(
      [
        { path: "package.json", content: JSON.stringify({ packageManager: "pnpm@11.2.2" }) },
        { path: "npm-shrinkwrap.json", content: "" },
      ],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBe("npm");
      },
    );
  });

  it("falls back to package.json when no lock file exists", async () => {
    await withPackageManagerRoot(
      [{ path: "package.json", content: JSON.stringify({ packageManager: "bun@1.2.0" }) }],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBe("bun");
      },
    );
  });

  it.each([
    {
      name: "uses bun.lock",
      files: [{ path: "bun.lock", content: "" }],
      expected: "bun",
    },
    {
      name: "uses bun.lockb",
      files: [{ path: "bun.lockb", content: "" }],
      expected: "bun",
    },
    {
      name: "detects npm from package-lock.json",
      files: [{ path: "package-lock.json", content: "" }],
      expected: "npm",
    },
  ])("detects package manager from $name", async ({ files, expected }) => {
    await withPackageManagerRoot(files, async (root) => {
      await expect(detectPackageManager(root)).resolves.toBe(expected);
    });
  });

  it("returns null when no package manager markers exist", async () => {
    await withPackageManagerRoot(
      [{ path: "package.json", content: "{not-json}" }],
      async (root) => {
        await expect(detectPackageManager(root)).resolves.toBeNull();
      },
    );
  });
});
