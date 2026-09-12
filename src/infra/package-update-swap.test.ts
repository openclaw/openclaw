import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

describe("retained package backup retirement", () => {
  it.each(["installer wrapper", "package link", "custom launcher"])(
    "restores the preserved dirty source through its %s after failed activation",
    async (owner) => {
      await withTestDir({ prefix: "openclaw-dirty-source-rollback-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const originalRoot = path.join(base, "original-source");
        const sha = "a".repeat(40);
        await fs.mkdir(path.join(originalRoot, "dist/control-ui/assets"), { recursive: true });
        for (const [file, contents] of Object.entries({
          "package.json": JSON.stringify({ name: "openclaw", version: "1.0.0" }),
          "local.txt": "operator edits\n",
          "dist/entry.js": "export {};\n",
          "dist/build-info.json": JSON.stringify({ commit: sha, buildId: "original-build" }),
          "dist/.buildstamp": JSON.stringify({ head: sha }),
          "dist/.runtime-postbuildstamp": JSON.stringify({ head: sha }),
          "dist/control-ui/index.html": '<script src="./assets/startup.js"></script>',
          "dist/control-ui/assets/startup.js": "export {};\n",
        })) {
          await fs.writeFile(path.join(originalRoot, file), contents);
        }
        await fs.rm(packageRoot, { recursive: true });
        const wrapper =
          owner === "custom launcher"
            ? "#!/bin/sh\necho custom\n"
            : `#!/usr/bin/env bash\nset -euo pipefail\nexec ${process.execPath} ${originalRoot}/dist/entry.js "$@"\n`;
        await fs.writeFile(launcher, wrapper);
        if (owner === "package link") {
          await fs.symlink(originalRoot, packageRoot);
        }
        const beforeActivate = vi.fn();
        const result = await swapStagedPackageInstall({
          ...params,
          previousGitCheckout: { root: originalRoot, sha },
          beforeActivate,
          postVerifyStep: async () => ({
            name: "verification",
            command: "doctor",
            cwd: packageRoot,
            exitCode: 1,
            durationMs: 0,
            stderrTail: "plugin failed",
          }),
        });
        expect(result).toMatchObject({
          status: "failed",
          packageRollbackVerified: owner !== "custom launcher",
        });
        if (owner === "custom launcher") {
          expect(beforeActivate).not.toHaveBeenCalled();
        } else {
          expect(result.activePackageRoot).toBe(originalRoot);
        }
        expect(await fs.readFile(launcher, "utf8")).toBe(wrapper);
        expect(await fs.readFile(path.join(originalRoot, "local.txt"), "utf8")).toBe(
          "operator edits\n",
        );
        expect(await fs.readFile(path.join(originalRoot, "dist/entry.js"), "utf8")).toBe(
          "export {};\n",
        );
      });
    },
  );
  it.each([false, true])(
    "does not copy or remove the old package after a denied backup rename (caller verified=%s)",
    async (activationVerified) => {
      await withTestDir({ prefix: "openclaw-retained-backup-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const rename = fs.rename.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === packageRoot) {
            throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
          }
          return rename(...args);
        });
        let transaction: PackageUpdateTransaction | undefined;
        let result;
        try {
          result = await swapStagedPackageInstall({
            ...params,
            onTransaction: (value) => {
              transaction = value;
            },
          });
        } finally {
          renameSpy.mockRestore();
        }
        expect(transaction).toBeDefined();
        expect(result).toMatchObject({ status: "failed", activePackageRoot: packageRoot });
        const completion = await transaction!.complete({ activationVerified }, () => {});
        await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
          "export {};\n",
        );
        await expect(fs.stat(transaction!.backupRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        expect(completion).toMatchObject({
          exitCode: 1,
          stderrTail: expect.stringContaining("Installation recovery is unverified"),
        });
      });
    },
  );

  it.each(["unverified activation", "verified activation", "verified rollback"] as const)(
    "retires backups only after a proven outcome: %s",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-retained-outcome-" }, async (base) => {
        const { result, transaction, packageRoot } = await createRetainedPackageSwap(base);
        expect(result.status).toBe("committed");
        if (outcome === "verified rollback") {
          expect(await transaction.rollback(() => {})).toMatchObject({
            exitCode: 0,
            activePackageRoot: packageRoot,
          });
        }
        const completion = await transaction.complete(
          {
            activationVerified: outcome === "verified activation",
          },
          () => {},
        );
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${outcome === "verified rollback" ? "1.0.0" : "2.0.0"}"`);
        if (outcome === "unverified activation") {
          await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
        } else {
          expect(completion).toBeUndefined();
          await expect(fs.stat(transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );
});
