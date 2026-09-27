import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
} from "./package-local-overrides.js";
import {
  writePackageRoot,
  expectPathMissing,
  useLocalOverrideTestState,
} from "./package-local-overrides.test-support.js";
useLocalOverrideTestState();

describe("local package overrides", () => {
  it.runIf(process.platform !== "win32")(
    "does not overwrite a modified target changed after replay preflight",
    async () => {
      await withTestDir({ prefix: "openclaw-package-update-local-late-replace-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        const realMkdtemp = fs.mkdtemp.bind(fs);
        let targetChanged = false;
        const mkdtempSpy = vi
          .spyOn(fs, "mkdtemp")
          .mockImplementation(async (prefixArg, options) => {
            const result = await realMkdtemp(prefixArg, options);
            if (!targetChanged && prefixArg.endsWith(`${path.sep}rollback-`)) {
              targetChanged = true;
              await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
            }
            return result;
          });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(targetChanged).toBe(true);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const concurrent = true;\n",
          );
        } finally {
          mkdtempSpy.mockRestore();
        }
      });
    },
  );

  it("does not overwrite a target created at the final replacement boundary", async () => {
    await withTestDir({ prefix: "openclaw-package-update-local-final-replace-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");

      const realRealpath = fs.realpath.bind(fs);
      let targetChanged = false;
      const realpathSpy = vi
        .spyOn(fs, "realpath")
        .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          const result = await realRealpath(...args);
          const entries =
            String(args[0]) === path.dirname(indexPath)
              ? await fs.readdir(path.dirname(indexPath)).catch(() => [] as string[])
              : [];
          if (
            !targetChanged &&
            entries.some((entry) => entry.startsWith(".openclaw-override-next-"))
          ) {
            targetChanged = true;
            await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
          }
          return result;
        });

      try {
        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(targetChanged).toBe(true);
        expect(result.status).toBe("error");
        expect(result.applied).toBe(0);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
          "export const concurrent = true;\n",
        );
        expect(
          (await fs.readdir(path.dirname(indexPath))).filter((entry) =>
            entry.startsWith(".openclaw-override-"),
          ),
        ).toEqual([]);
      } finally {
        realpathSpy.mockRestore();
      }
    });
  });

  it("does not report a deletion applied when the target is recreated during cleanup", async () => {
    await withTestDir(
      { prefix: "openclaw-package-update-local-recreated-delete-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        let targetRecreated = false;
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: async (operation, targetPath) => {
            if (
              !targetRecreated &&
              operation === "remove" &&
              path.basename(targetPath).startsWith(".openclaw-override-previous-")
            ) {
              targetRecreated = true;
              await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
            }
          },
        });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(targetRecreated).toBe(true);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const concurrent = true;\n",
          );
        } finally {
          __setFsSafeTestHooksForTest(undefined);
        }
      },
    );
  });

  it("treats deletions already satisfied by the updated package as a no-op", async () => {
    await withTestDir(
      { prefix: "openclaw-package-update-local-deleted-upstream-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");
        await fs.rm(indexPath);
        await writePackageDistInventory(packageRoot);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([]);
        await expectPathMissing(indexPath);
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "reapplies overrides when Windows reports synthetic installed modes",
    async () => {
      await withTestDir({ prefix: "openclaw-package-update-local-windows-mode-" }, async (base) => {
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
        await fs.chmod(indexPath, 0o666);

        const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        let result;
        try {
          result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });
        } finally {
          platformSpy.mockRestore();
        }

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual([]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export const local = true;\n");
      });
    },
  );
});
