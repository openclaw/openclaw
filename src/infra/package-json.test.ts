import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { readPackageName, readPackageVersion } from "./package-json.js";

describe("package-json helpers", () => {
  it("reads package version and trims package name", async () => {
    await withTempDir({ prefix: "openclaw-package-json-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ version: "1.2.3", name: "  @openclaw/demo  " }),
        "utf8",
      );

      await expect(readPackageVersion(root)).resolves.toBe("1.2.3");
      await expect(readPackageName(root)).resolves.toBe("@openclaw/demo");
    });
  });

  it("returns null for missing or invalid package.json data", async () => {
    await withTempDir({ prefix: "openclaw-package-json-" }, async (root) => {
      await expect(readPackageVersion(root)).resolves.toBeNull();
      await expect(readPackageName(root)).resolves.toBeNull();

      await fs.writeFile(path.join(root, "package.json"), "{", "utf8");
      await expect(readPackageVersion(root)).resolves.toBeNull();
      await expect(readPackageName(root)).resolves.toBeNull();

      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ version: 123, name: "   " }),
        "utf8",
      );
      await expect(readPackageVersion(root)).resolves.toBeNull();
      await expect(readPackageName(root)).resolves.toBeNull();
    });
  });
});
