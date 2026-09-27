import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

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
      const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
      const copy = vi.spyOn(prototype, "copyIn");
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
        const shimBackupPath = await fs.realpath(path.join(globalRoot, shimBackup));
        const launcherParent = await fs.realpath(path.dirname(launcher));
        let current = true;
        let injections = 0;
        const revoke = () => {
          if (current) {
            injections += 1;
            current = false;
          }
        };
        const lost = new Error("original executor lost");
        const assertCurrent = () => {
          if (!current) {
            throw lost;
          }
        };
        const staleEffects: string[] = [];
        const privateStages = new Set<string>();
        const record = (operation: string, destination: string) => {
          // Unpublished, operation-owned launcher scratch is disposable even
          // after revocation; live paths and retained evidence are not.
          const privateTarget = [...privateStages].some(
            (stage) => destination === stage || destination.startsWith(`${stage}${path.sep}`),
          );
          if (!current && !privateTarget) {
            staleEffects.push(`${operation}: ${destination}`);
          }
        };
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const result = await lstat(...args);
          if (boundary === "integrity" && String(args[0]) === transaction.backupRoot) {
            revoke();
          }
          return result;
        });
        const rename = fs.rename.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          record("rename", String(args[1]));
          if (boundary === "compensation" && String(args[0]) === transaction.backupRoot) {
            revoke();
            throw Object.assign(new Error("restore denied"), { code: "EACCES" });
          }
          await rename(...args);
          if (boundary === "displacement" && String(args[0]) === packageRoot) {
            revoke();
          }
        });
        const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
        // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
        const copy = prototype.copyIn;
        vi.spyOn(prototype, "copyIn").mockImplementation(async function (
          this: Root,
          target,
          source,
          options,
        ) {
          expect(path.dirname(this.rootReal)).toBe(launcherParent);
          expect(path.basename(this.rootReal)).toMatch(/^\.openclaw-shim-stage-/);
          privateStages.add(this.rootReal);
          record("copy", path.join(this.rootReal, target));
          await copy.call(this, target, source, options);
          if (boundary === "launcher") {
            revoke();
          }
        });
        const chmod = fs.chmod.bind(fs);
        vi.spyOn(fs, "chmod").mockImplementation(async (...args) => {
          record("chmod", String(args[0]));
          return chmod(...args);
        });
        const unlink = fs.unlink.bind(fs);
        vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
          record("unlink", String(args[0]));
          await unlink(...args);
        });
        const rmdir = fs.rmdir.bind(fs);
        vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
          record("rmdir", String(args[0]));
          await rmdir(...args);
        });
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation(operation, target) {
            if (
              boundary === "retirement" &&
              operation === "remove" &&
              (target === shimBackupPath || target.startsWith(`${shimBackupPath}${path.sep}`))
            ) {
              revoke();
            }
          },
        });
        await expect(transaction.rollback(assertCurrent)).rejects.toBe(lost);
        expect(current).toBe(false);
        expect(injections).toBe(1);
        expect(staleEffects).toEqual([]);
        expect(() => transaction.rollback(() => {})).toThrow(lost);
        await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toBe(
          lost,
        );
        expect(staleEffects).toEqual([]);
        expect(injections).toBe(1);
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
      const backupRoot = await fs.realpath(transaction.backupRoot);
      let injections = 0;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation(operation, target) {
          if (
            operation === "remove" &&
            (target === backupRoot || target.startsWith(`${backupRoot}${path.sep}`))
          ) {
            injections += 1;
            current = false;
          }
        },
      });
      const unlink = vi.spyOn(fs, "unlink");
      const rmdir = vi.spyOn(fs, "rmdir");
      const rename = vi.spyOn(fs, "rename");
      await expect(
        transaction.complete({ activationVerified: true }, assertCurrent),
      ).rejects.toThrow("retirement executor lost");
      await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
        "retirement executor lost",
      );
      expect(injections).toBe(1);
      expect(rename).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect(rmdir).not.toHaveBeenCalled();
      await expect(
        fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
    });
  });
});
