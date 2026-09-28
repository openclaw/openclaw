import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  collectPackageDistContentInventoryErrors,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  readPackageDistContentInventoryIfPresent,
} from "./package-dist-inventory.js";

describe("package content inventory contract", () => {
  it("advertises hashes, tolerates npm umask normalization, and detects changed bytes", async () => {
    await withTestDir({ prefix: "openclaw-content-inventory-" }, async (root) => {
      await fs.mkdir(path.join(root, "dist"));
      const entry = path.join(root, "dist/index.js");
      await fs.writeFile(entry, "export {};\n", { mode: 0o755 });
      const files = await writePackageDistInventory(root);
      expect(files).toContain(PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH);
      expect(await collectPackageDistContentInventoryErrors(root)).toEqual([]);
      if (process.platform !== "win32") {
        await fs.chmod(entry, 0o700);
        expect(await collectPackageDistContentInventoryErrors(root)).toEqual([]);
        await fs.chmod(entry, 0o600);
        expect(await collectPackageDistContentInventoryErrors(root)).not.toEqual([]);
      }
      await fs.writeFile(entry, "export const altered = true;\n");
      expect(await collectPackageDistContentInventoryErrors(root)).not.toEqual([]);
    });
  });

  it("accepts filename-only artifacts without version exceptions but refuses a missing advertised hash file", async () => {
    await withTestDir({ prefix: "openclaw-content-capability-" }, async (root) => {
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
      );
      await fs.writeFile(path.join(root, "dist/index.js"), "export {};\n");
      const inventoryPath = path.join(root, "dist/postinstall-inventory.json");
      await fs.writeFile(inventoryPath, JSON.stringify(["dist/index.js"]));
      expect(await readPackageDistContentInventoryIfPresent(root)).toBeNull();
      expect(await collectPackageDistContentInventoryErrors(root)).toEqual([]);
      await writePackageDistInventory(root);
      await fs.rm(path.join(root, PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH));
      await expect(readPackageDistContentInventoryIfPresent(root)).rejects.toThrow(
        "missing package dist content inventory",
      );
    });
  });

  it.each([null, {}, [{ path: "dist/../outside", sha256: "0".repeat(64), size: 0, mode: 0o600 }]])(
    "rejects malformed or unsafe metadata %j",
    async (contents) => {
      await withTestDir({ prefix: "openclaw-content-malformed-" }, async (root) => {
        await fs.mkdir(path.join(root, "dist"));
        await fs.writeFile(path.join(root, "dist/postinstall-inventory.json"), "[]");
        await fs.writeFile(
          path.join(root, PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH),
          JSON.stringify(contents),
        );
        await expect(readPackageDistContentInventoryIfPresent(root)).rejects.toThrow(
          "Invalid package dist content inventory",
        );
      });
    },
  );

  it("rejects redirected metadata without reading the outside payload", async () => {
    await withTestDir({ prefix: "openclaw-content-symlink-" }, async (root) => {
      await fs.mkdir(path.join(root, "dist"));
      const outside = path.join(root, "outside.json");
      await fs.writeFile(outside, "[]");
      await fs.symlink(outside, path.join(root, PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH));
      await expect(readPackageDistContentInventoryIfPresent(root)).rejects.toThrow();
      expect(await fs.readFile(outside, "utf8")).toBe("[]");
    });
  });
});
