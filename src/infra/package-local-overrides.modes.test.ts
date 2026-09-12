import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
} from "./package-local-overrides.js";
import {
  writePackageRoot,
  useLocalOverrideTestState,
} from "./package-local-overrides.test-support.js";
useLocalOverrideTestState();

describe("local package overrides", () => {
  it.runIf(process.platform !== "win32").each(["modified", "deleted"] as const)(
    "does not reapply %s overrides over upstream mode changes",
    async (overrideKind) => {
      await withTestDir(
        { prefix: `openclaw-package-update-local-mode-${overrideKind}-` },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.chmod(indexPath, 0o644);
          await writePackageDistInventory(packageRoot);
          if (overrideKind === "modified") {
            await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          } else {
            await fs.rm(indexPath);
          }

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await fs.writeFile(indexPath, "export {};\n", "utf8");
          await fs.chmod(indexPath, 0o755);
          await writePackageDistInventory(packageRoot);

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("conflict");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")("captures and reapplies mode-only overrides", async () => {
    await withTestDir({ prefix: "openclaw-package-update-local-mode-only-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.chmod(indexPath, 0o644);
      await writePackageDistInventory(packageRoot);
      await fs.chmod(indexPath, 0o755);

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      expect(plan?.result.modified).toBe(1);

      await writePackageRoot(packageRoot, "2.0.0");
      await fs.chmod(indexPath, 0o644);
      await writePackageDistInventory(packageRoot);

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("applied");
      expect(result.applied).toBe(1);
      await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
      expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not classify npm umask normalization as a local edit",
    async () => {
      await withTestDir({ prefix: "openclaw-package-update-umask-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        await writePackageRoot(packageRoot, "1.0.0");
        const entry = path.join(packageRoot, "dist/index.js");
        await fs.chmod(entry, 0o755);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(entry, 0o700);
        expect(await captureLocalPackageOverrides({ packageRoot })).toBeNull();
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "ignores non-executable mode normalization during capture",
    async () => {
      await withTestDir(
        { prefix: "openclaw-package-update-local-mode-normalized-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.chmod(indexPath, 0o644);
          await writePackageDistInventory(packageRoot);
          await fs.chmod(indexPath, 0o600);

          await expect(captureLocalPackageOverrides({ packageRoot })).resolves.toBeNull();
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "reapplies byte overrides over non-executable mode normalization",
    async () => {
      await withTestDir({ prefix: "openclaw-package-update-local-mode-reapply-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(indexPath, 0o600);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual([]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export const local = true;\n");
        expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o600);
      });
    },
  );

  it("captures and reapplies locally added files excluded from package files", async () => {
    await withTestDir({ prefix: "openclaw-package-update-local-excluded-files-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const localFiles = new Map([
        ["dist/index.js.map", '{"version":3,"sources":["index.ts"]}\n'],
        ["dist/local-runtime.js", "export const local = true;\n"],
        ["dist/local-assets/theme.css", "body {}\n"],
        ["dist/local-assets/runtime.wasm", "local wasm\n"],
        ["dist/local-assets/settings.json", '{"local":true}\n'],
      ]);
      const writePackageJson = async (version: string) => {
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            version,
            files: ["dist/", "!dist/**/*.map", "!dist/local-runtime.js", "!dist/local-assets/**"],
          }),
          "utf8",
        );
      };
      await writePackageRoot(packageRoot, "1.0.0");
      await writePackageJson("1.0.0");
      await writePackageDistInventory(packageRoot);
      for (const [relativePath, content] of localFiles) {
        const filePath = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      }

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      expect(plan?.result.added).toBe(localFiles.size);

      await writePackageRoot(packageRoot, "2.0.0");
      await writePackageJson("2.0.0");
      for (const relativePath of localFiles.keys()) {
        await fs.rm(path.join(packageRoot, relativePath));
      }
      await writePackageDistInventory(packageRoot);

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("applied");
      expect(result.applied).toBe(localFiles.size);
      for (const [relativePath, content] of localFiles) {
        await expect(fs.readFile(path.join(packageRoot, relativePath), "utf8")).resolves.toBe(
          content,
        );
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not reapply overrides after an unrecorded installed mode change",
    async () => {
      await withTestDir({ prefix: "openclaw-package-update-local-actual-mode-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await fs.writeFile(indexPath, "export {};\n", "utf8");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(indexPath, 0o755);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("conflict");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
        expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
      });
    },
  );

  it.each(["modified", "deleted"] as const)(
    "does not reapply %s overrides after an unrecorded installed byte change",
    async (overrideKind) => {
      await withTestDir(
        { prefix: `openclaw-package-update-local-actual-bytes-${overrideKind}-` },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          if (overrideKind === "modified") {
            await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          } else {
            await fs.rm(indexPath);
          }

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await fs.writeFile(indexPath, "export {};\n", "utf8");
          await writePackageDistInventory(packageRoot);
          await fs.writeFile(indexPath, "export const changedAfterVerify = true;\n", "utf8");

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("conflict");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const changedAfterVerify = true;\n",
          );
        },
      );
    },
  );
});
