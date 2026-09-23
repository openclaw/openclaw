import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("retained package transaction authority", () => {
  it("stops a partial npm activation before launcher compensation after executor loss", async () => {
    await withTestDir({ prefix: "openclaw-partial-rollback-owner-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (value) => {
          transaction = value;
          unlinkSync(path.join(params.stage.layout.binDir, "openclaw"));
        },
      });
      expect(result.status).toBe("failed");
      if (!transaction) {
        throw new Error("Missing retained partial activation");
      }
      const launcherIdentity = (await fs.lstat(launcher)).ino;
      const candidate = `${transaction.backupRoot}.candidate`;
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("partial activation executor lost");
        }
      };
      const rename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        current = false;
      });
      const copy = vi.spyOn(fs, "copyFile");
      await expect(transaction.rollback(assertCurrent)).rejects.toThrow(
        "partial activation executor lost",
      );
      await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
        "partial activation executor lost",
      );
      expect(renameSpy).toHaveBeenCalledExactlyOnceWith(packageRoot, candidate);
      expect(copy).not.toHaveBeenCalled();
      expect((await fs.lstat(launcher)).ino).toBe(launcherIdentity);
      await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(candidate, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expect(
        fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
    });
  });

  it.each(["integrity", "displacement", "compensation", "launcher", "retirement"] as const)(
    "stops rollback and preserves recovery material after ownership loss during %s",
    async (boundary) => {
      await withTestDir({ prefix: "openclaw-rollback-owner-" }, async (base) => {
        const { transaction, packageRoot, launcher, globalRoot } =
          await createRetainedPackageSwap(base);
        const candidate = `${transaction.backupRoot}.candidate`;
        const shimBackup = (await fs.readdir(globalRoot)).find((entry) =>
          entry.startsWith(".openclaw.shim-backup-"),
        )!;
        let current = true;
        const lost = new Error("original executor lost");
        const assertCurrent = () => {
          if (!current) {
            throw lost;
          }
        };
        const staleEffects: string[] = [];
        const record = (operation: string, destination: string) => {
          // Unpublished, operation-owned launcher scratch is disposable even
          // after revocation; live paths and retained evidence are not.
          if (!current && !destination.includes(".openclaw-shim-stage-")) {
            staleEffects.push(`${operation}: ${destination}`);
          }
        };
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const result = await lstat(...args);
          if (boundary === "integrity" && String(args[0]) === transaction.backupRoot) {
            current = false;
          }
          return result;
        });
        const rename = fs.rename.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          record("rename", String(args[1]));
          if (boundary === "compensation" && String(args[0]) === transaction.backupRoot) {
            current = false;
            throw Object.assign(new Error("restore denied"), { code: "EACCES" });
          }
          await rename(...args);
          if (boundary === "displacement" && String(args[0]) === packageRoot) {
            current = false;
          }
        });
        const copyFile = fs.copyFile.bind(fs);
        vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
          record("copy", String(args[1]));
          await copyFile(...args);
          if (boundary === "launcher") {
            current = false;
          }
        });
        const chmod = fs.chmod.bind(fs);
        vi.spyOn(fs, "chmod").mockImplementation(async (...args) => {
          record("chmod", String(args[0]));
          return chmod(...args);
        });
        const rm = fs.rm.bind(fs);
        vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          record("remove", String(args[0]));
          if (boundary === "retirement" && String(args[0]) === path.join(globalRoot, shimBackup)) {
            current = false;
            throw Object.assign(new Error("retirement denied"), { code: "EACCES" });
          }
          return rm(...args);
        });
        await expect(transaction.rollback(assertCurrent)).rejects.toBe(lost);
        expect(current).toBe(false);
        expect(staleEffects).toEqual([]);
        expect(() => transaction.rollback(() => {})).toThrow(lost);
        await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toBe(
          lost,
        );
        expect(staleEffects).toEqual([]);
        expect(await fs.readdir(path.dirname(launcher))).toEqual(["openclaw"]);
        await expect(fs.stat(path.join(globalRoot, shimBackup))).resolves.toBeDefined();
        if (boundary === "integrity") {
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
          expect(renameSpy).not.toHaveBeenCalled();
        } else {
          await expect(
            fs.readFile(path.join(candidate, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
        }
        if (boundary === "displacement" || boundary === "compensation") {
          await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const previous =
          boundary === "launcher" || boundary === "retirement"
            ? packageRoot
            : transaction.backupRoot;
        await expect(fs.readFile(path.join(previous, "package.json"), "utf8")).resolves.toContain(
          '"version":"1.0.0"',
        );
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe(
          boundary === "retirement" ? "old launcher\n" : "candidate launcher\n",
        );
      });
    },
  );

  it("keeps the original completion authority through a failed backup removal", async () => {
    await withTestDir({ prefix: "openclaw-retirement-owner-" }, async (base) => {
      const { transaction, packageRoot } = await createRetainedPackageSwap(base);
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("retirement executor lost");
        }
      };
      const rm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (String(args[0]) === transaction.backupRoot) {
          current = false;
          throw Object.assign(new Error("remove denied"), { code: "EACCES" });
        }
        return rm(...args);
      });
      const rename = vi.spyOn(fs, "rename");
      await expect(
        transaction.complete({ activationVerified: true }, assertCurrent),
      ).rejects.toThrow("retirement executor lost");
      await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
        "retirement executor lost",
      );
      expect(rename).not.toHaveBeenCalled();
      await expect(
        fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
    });
  });
});
