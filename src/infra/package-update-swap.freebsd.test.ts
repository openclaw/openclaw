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
import { swapStagedPackageInstall } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";
import { pkgQueryResult } from "./update-freebsd-pkg-ownership.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function expectPackageVersion(packageRoot: string, version: string) {
  expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
    `"version":"${version}"`,
  );
}

describe("FreeBSD package replacement ownership", () => {
  it.each([
    { kind: "directory", ownership: "artifact" },
    { kind: "symlink", ownership: "artifact" },
    { kind: "symlink", ownership: "target" },
    { kind: "directory", ownership: "unavailable" },
  ] as const)(
    "preserves pkg ownership when retiring a historical $kind ($ownership)",
    async ({ kind, ownership }) => {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await withTestDir({ prefix: "openclaw-pkg-historical-backup-" }, async (base) => {
        const checkout = path.join(base, "checkout");
        await fs.mkdir(checkout);
        await fs.writeFile(path.join(checkout, "sentinel"), "operator checkout");
        const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
        await withMockedPlatform("freebsd", async () => {
          const { transaction, globalRoot, packageRoot } = await createRetainedPackageSwap(
            base,
            async ({ globalRoot: fixtureGlobalRoot }) => {
              const historical = path.join(fixtureGlobalRoot, ".openclaw.package-backup-1-100");
              if (kind === "symlink") {
                await fs.symlink(checkout, historical, linkType);
              } else {
                await fs.mkdir(historical);
                await fs.writeFile(path.join(historical, "sentinel"), "historical package");
              }
              const later = path.join(fixtureGlobalRoot, ".openclaw.package-backup-2-200");
              await fs.mkdir(later);
              await fs.writeFile(path.join(later, "sentinel"), "second historical package");
            },
          );
          const historical = path.join(globalRoot, ".openclaw.package-backup-1-100");
          const later = path.join(globalRoot, ".openclaw.package-backup-2-200");
          const registered =
            ownership === "target"
              ? path.join(checkout, "sentinel")
              : kind === "symlink"
                ? historical
                : path.join(historical, "sentinel");
          // Package ownership can change after capture and successful activation.
          query
            .mockClear()
            .mockResolvedValue(
              ownership === "unavailable"
                ? pkgQueryResult("", { code: 1 })
                : pkgQueryResult(`${registered}\n`),
            );

          const completion = await transaction.complete({ activationVerified: true }, () => {});

          if (ownership === "target") {
            expect(completion).toBeUndefined();
            await expect(fs.lstat(historical)).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect(completion).toMatchObject({
              advisory: {
                kind: "recoverable-maintenance",
                message: expect.stringContaining("FreeBSD pkg"),
              },
            });
            await expect(fs.lstat(historical)).resolves.toBeDefined();
          }
          if (ownership === "unavailable") {
            expect(query).toHaveBeenCalledOnce();
            expect(await fs.readFile(path.join(later, "sentinel"), "utf8")).toBe(
              "second historical package",
            );
          } else {
            await expect(fs.lstat(later)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(await fs.readFile(path.join(checkout, "sentinel"), "utf8")).toBe(
            "operator checkout",
          );
          await expectPackageVersion(packageRoot, "2.0.0");
        });
      });
    },
  );

  it("retains the installed candidate and recovery copy when pkg claims a launcher before rollback", async () => {
    await withTestDir({ prefix: "openclaw-pkg-rollback-" }, async (base) => {
      const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
      await withMockedPlatform("freebsd", async () => {
        const { transaction, packageRoot, launcher } = await createRetainedPackageSwap(base);
        query.mockResolvedValue(pkgQueryResult(`${launcher}\n`));
        await expect(transaction.rollback(() => {})).resolves.toMatchObject({
          exitCode: 1,
          stderrTail: expect.stringContaining("retained for manual recovery"),
        });
        await expectPackageVersion(transaction.backupRoot, "1.0.0");
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
        await expectPackageVersion(packageRoot, "2.0.0");
      });
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
      await expectPackageVersion(target.packageRoot!, "1.0.0");
    });
  });
  it.each([
    { owned: "launcher", acquired: "before service preparation" },
    { owned: "package root", acquired: "during service drain" },
  ] as const)("preserves a pkg-owned $owned acquired $acquired", async ({ owned, acquired }) => {
    await withTestDir({ prefix: "openclaw-pkg-swap-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const file = owned === "launcher" ? launcher : path.join(packageRoot, "package.json");
      const duringDrain = acquired === "during service drain";
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockResolvedValue(pkgQueryResult(duringDrain ? "" : `${file}\n`));
      const beforeActivate = vi.fn(async () => {
        query.mockResolvedValue(pkgQueryResult(`${file}\n`));
      });
      const onLiveMutation = vi.fn();
      const onTransaction = vi.fn();
      await withMockedPlatform("freebsd", async () => {
        await expect(
          swapStagedPackageInstall({ ...params, beforeActivate, onLiveMutation, onTransaction }),
        ).rejects.toMatchObject({ cause: { reason: "pkg-owned-install" } });
      });
      expect(beforeActivate).toHaveBeenCalledTimes(duringDrain ? 1 : 0);
      expect(query).toHaveBeenCalledTimes(duringDrain ? 2 : 1);
      expect(onLiveMutation).not.toHaveBeenCalled();
      expect(onTransaction).not.toHaveBeenCalled();
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
      await expectPackageVersion(packageRoot, "1.0.0");
    });
  });

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
      await expectPackageVersion(packageRoot, "1.0.0");
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
      await expectPackageVersion(packageRoot, "2.0.0");
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
