import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { pkgQueryResult } from "./update-freebsd-pkg-ownership.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("FreeBSD package replacement ownership", () => {
  it("retains the installed candidate and recovery copy when pkg claims a launcher before rollback", async () => {
    await withTestDir({ prefix: "openclaw-pkg-rollback-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
      let transaction: PackageUpdateTransaction | undefined;
      await withMockedPlatform("freebsd", async () => {
        await expect(
          swapStagedPackageInstall({
            ...params,
            onTransaction: (value) => {
              transaction = value;
            },
          }),
        ).resolves.toMatchObject({ status: "committed" });
        if (!transaction) {
          throw new Error("Expected a retained package transaction");
        }
        query.mockResolvedValue(pkgQueryResult(`${launcher}\n`));
        await expect(transaction.rollback(() => {})).resolves.toMatchObject({
          exitCode: 1,
          stderrTail: expect.stringContaining("retained for manual recovery"),
        });
        await expect(
          fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      });
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
    });
  });
  it("refuses an uninspectable in-place fallback instead of running the manager", async () => {
    await withTestDir({ prefix: "openclaw-pkg-in-place-" }, async (base) => {
      const target = createNpmTarget(path.join(base, "unrecognized-layout"));
      await writePackageRoot(target.packageRoot!, "1.0.0");
      vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
      const runStep = vi.fn();
      await withMockedPlatform("freebsd", async () => {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: target,
          packageRoot: target.packageRoot,
          packageName: "openclaw",
          installSpec: "openclaw@2.0.0",
          timeoutMs: 1000,
          runCommand: createRootRunner(target.globalRoot!),
          runStep,
        });
        expect(result.failedStep).toMatchObject({
          name: "package-stage",
          stderrTail: expect.stringContaining("cannot prepare the update"),
        });
      });
      expect(runStep).not.toHaveBeenCalled();
      await expect(
        fs.readFile(path.join(target.packageRoot!, "package.json"), "utf8"),
      ).resolves.toContain('"version":"1.0.0"');
    });
  });
  it.each(["package root", "launcher"])(
    "preserves a pkg-owned %s before service preparation",
    async (owned) => {
      await withTestDir({ prefix: "openclaw-pkg-swap-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const file = owned === "launcher" ? launcher : path.join(packageRoot, "package.json");
        vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult(`${file}\n`));
        const beforeActivate = vi.fn();
        const onLiveMutation = vi.fn();
        const onTransaction = vi.fn();
        await withMockedPlatform("freebsd", async () => {
          await expect(
            swapStagedPackageInstall({ ...params, beforeActivate, onLiveMutation, onTransaction }),
          ).rejects.toMatchObject({ cause: { reason: "pkg-owned-install" } });
        });
        expect(beforeActivate).not.toHaveBeenCalled();
        expect(onLiveMutation).not.toHaveBeenCalled();
        expect(onTransaction).not.toHaveBeenCalled();
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      });
    },
  );

  it.each(["package root", "launcher"])(
    "rechecks pkg ownership acquired during service drain (%s)",
    async (owned) => {
      await withTestDir({ prefix: "openclaw-pkg-drain-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
        const beforeActivate = vi.fn(async () => {
          const file = owned === "launcher" ? launcher : path.join(packageRoot, "package.json");
          query.mockResolvedValue(pkgQueryResult(`${file}\n`));
        });
        const onLiveMutation = vi.fn();
        const onTransaction = vi.fn();
        await withMockedPlatform("freebsd", async () => {
          await expect(
            swapStagedPackageInstall({ ...params, beforeActivate, onLiveMutation, onTransaction }),
          ).rejects.toMatchObject({ cause: { reason: "pkg-owned-install" } });
        });
        expect(beforeActivate).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledTimes(2);
        expect(onLiveMutation).not.toHaveBeenCalled();
        expect(onTransaction).not.toHaveBeenCalled();
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      });
    },
  );

  it("rechecks executor authority after the final pkg query", async () => {
    await withTestDir({ prefix: "openclaw-pkg-fence-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      let current = true;
      const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
      const beforeActivate = async () => {
        query.mockImplementation(async () => {
          current = false;
          return pkgQueryResult();
        });
      };
      const onLiveMutation = vi.fn();
      const onTransaction = vi.fn();
      await withMockedPlatform("freebsd", async () => {
        const result = await swapStagedPackageInstall({
          ...params,
          beforeActivate,
          onLiveMutation,
          onTransaction,
          assertCurrent: () => {
            if (!current) {
              throw new Error("executor revoked");
            }
          },
        });
        expect(result).toMatchObject({
          status: "failed",
          step: { stderrTail: expect.stringContaining("executor revoked") },
        });
      });
      expect(onLiveMutation).not.toHaveBeenCalled();
      expect(onTransaction).not.toHaveBeenCalled();
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it("allows an unowned installation beside a pkg-owned Node launcher", async () => {
    await withTestDir({ prefix: "openclaw-pkg-sibling-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const node = path.join(path.dirname(launcher), "node");
      await fs.writeFile(node, "system node\n");
      vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult(`${node}\n`));
      await withMockedPlatform("freebsd", async () => {
        await expect(swapStagedPackageInstall(params)).resolves.toMatchObject({
          status: "committed",
        });
      });
      await expect(fs.readFile(node, "utf8")).resolves.toBe("system node\n");
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
    });
  });

  it("refuses pkg ownership before package-manager staging or in-place installation", async () => {
    await withTestDir({ prefix: "openclaw-pkg-steps-" }, async (base) => {
      const { params, packageRoot, globalRoot } = await createPackageSwapFixture(base);
      vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
        pkgQueryResult(`${packageRoot}/package.json\n`),
      );
      const runStep = vi.fn();
      await withMockedPlatform("freebsd", async () => {
        await expect(
          runGlobalPackageUpdateSteps({
            installTarget: params.installTarget,
            packageRoot,
            packageName: "openclaw",
            installSpec: "openclaw@2.0.0",
            timeoutMs: 1000,
            runCommand: createRootRunner(globalRoot),
            runStep,
          }),
        ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      });
      expect(runStep).not.toHaveBeenCalled();
    });
  });
});
