import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
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

const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
let query: MockInstance<typeof exec.runCommandBuffered>;
beforeEach(() => {
  base = dirs.make("package-ownership-");
  query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(pkgQueryResult());
});
afterEach(() => vi.restoreAllMocks());

const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
async function expectVersion(root: string, version: string) {
  expect(await readText(root, "package.json")).toContain(`"version":"${version}"`);
}
async function expectUnchanged(fixture: Awaited<ReturnType<typeof createPackageSwapFixture>>) {
  await expectVersion(fixture.packageRoot, "1.0.0");
  expect(await readText(fixture.launcher)).toBe("old launcher\n");
}
function update(
  installTarget: ReturnType<typeof createNpmTarget>,
  runStep: Parameters<typeof runGlobalPackageUpdateSteps>[0]["runStep"],
) {
  return runGlobalPackageUpdateSteps({
    installTarget,
    packageRoot: installTarget.packageRoot,
    packageName: "openclaw",
    installSpec: "openclaw@2.0.0",
    timeoutMs: 1000,
    runCommand: createRootRunner(installTarget.globalRoot!),
    runStep,
  });
}

describe("system package replacement ownership", () => {
  it.each(
    (["freebsd", "linux"] as const).flatMap((platform) =>
      [
        ["directory", "artifact"],
        ["symlink", "artifact"],
        ["symlink", "target"],
        ["directory", "unavailable"],
      ].map(([kind, ownership]) => ({ kind, ownership, platform })),
    ),
  )(
    "retires a historical $kind with $platform ownership $ownership",
    async ({ kind, ownership, platform }) => {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      const checkout = path.join(base, "checkout");
      await fs.mkdir(checkout);
      await fs.writeFile(path.join(checkout, "sentinel"), "operator checkout");
      await withMockedPlatform(platform, async () => {
        const historicalName = ".openclaw.package-backup-1-100";
        const laterName = ".openclaw.package-backup-2-200";
        const { transaction, globalRoot, packageRoot } = await createRetainedPackageSwap(
          base,
          async ({ globalRoot: fixtureRoot }) => {
            const historical = path.join(fixtureRoot, historicalName);
            if (kind === "symlink") {
              await fs.symlink(checkout, historical, linkType);
            } else {
              await fs.mkdir(historical);
              await fs.writeFile(path.join(historical, "sentinel"), "historical package");
            }
            await fs.mkdir(path.join(fixtureRoot, laterName));
            await fs.writeFile(
              path.join(fixtureRoot, laterName, "sentinel"),
              "second historical package",
            );
          },
        );
        const historical = path.join(globalRoot, historicalName);
        const registered =
          ownership === "target"
            ? path.join(checkout, "sentinel")
            : kind === "symlink"
              ? historical
              : path.join(historical, "sentinel");
        // Ownership may change after capture and activation.
        query
          .mockClear()
          .mockResolvedValue(
            ownership === "unavailable"
              ? pkgQueryResult("", { code: 1 })
              : pkgQueryResult(`${registered}\n`),
          );
        const completion = await transaction.complete({ activationVerified: true }, () => {});
        if (ownership === "target" || ownership === "unavailable") {
          expect(completion).toBeUndefined();
          await expect(fs.lstat(historical)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(completion).toMatchObject({
            advisory: {
              kind: "recoverable-maintenance",
              message: expect.stringContaining(platform === "freebsd" ? "FreeBSD pkg" : "pacman"),
            },
          });
          await expect(fs.lstat(historical)).resolves.toBeDefined();
        }
        if (ownership === "unavailable") {
          expect(query).toHaveBeenCalledTimes(2);
        }
        await expect(fs.lstat(path.join(globalRoot, laterName))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readText(checkout, "sentinel")).toBe("operator checkout");
        await expectVersion(packageRoot, "2.0.0");
      });
    },
  );

  it("retains candidate and recovery copy when pkg claims a launcher before rollback", async () => {
    await withMockedPlatform("freebsd", async () => {
      const { transaction, packageRoot, launcher } = await createRetainedPackageSwap(base);
      query.mockResolvedValue(pkgQueryResult(`${launcher}\n`));
      await expect(transaction.rollback(() => {})).resolves.toMatchObject({
        exitCode: 1,
        stderrTail: expect.stringContaining("retained for manual recovery"),
      });
      await expectVersion(transaction.backupRoot, "1.0.0");
      expect(await readText(launcher)).toBe("candidate launcher\n");
      await expectVersion(packageRoot, "2.0.0");
    });
  });

  it("refuses an uninspectable in-place fallback instead of running the manager", async () => {
    const target = createNpmTarget(path.join(base, "unrecognized-layout"));
    await writePackageRoot(target.packageRoot!, "1.0.0");
    const runStep = vi.fn();
    await withMockedPlatform("freebsd", async () => {
      expect((await update(target, runStep)).failedStep).toMatchObject({
        name: "package-stage",
        stderrTail: expect.stringContaining("cannot prepare the update"),
      });
    });
    expect(runStep).not.toHaveBeenCalled();
    await expectVersion(target.packageRoot!, "1.0.0");
  });

  it.each(["ownership", "executor"] as const)("rechecks %s after service drain", async (loss) => {
    const f = await createPackageSwapFixture(base);
    let current = true;
    const beforeActivate = vi.fn(async () => {
      if (loss === "ownership") {
        query.mockResolvedValue(pkgQueryResult(`${f.packageRoot}/package.json\n`));
      } else {
        query.mockImplementation(async () => {
          current = false;
          return pkgQueryResult();
        });
      }
    });
    const onLiveMutation = vi.fn(),
      onTransaction = vi.fn();
    await withMockedPlatform("freebsd", async () => {
      const result = swapStagedPackageInstall({
        ...f.params,
        beforeActivate,
        onLiveMutation,
        onTransaction,
        ...(loss === "executor"
          ? {
              assertCurrent: () => {
                if (!current) {
                  throw new Error("executor revoked");
                }
              },
            }
          : {}),
      });
      if (loss === "ownership") {
        await expect(result).rejects.toMatchObject({ cause: { reason: "pkg-owned-install" } });
      } else {
        await expect(result).resolves.toMatchObject({
          status: "failed",
          step: { stderrTail: expect.stringContaining("executor revoked") },
        });
      }
    });
    if (loss === "ownership") {
      expect(beforeActivate).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledTimes(2);
    }
    expect(onLiveMutation).not.toHaveBeenCalled();
    expect(onTransaction).not.toHaveBeenCalled();
    await expectUnchanged(f);
  });

  it("refuses pkg ownership before package-manager staging or in-place installation", async () => {
    const { params, packageRoot } = await createPackageSwapFixture(base);
    query.mockResolvedValue(pkgQueryResult(`${packageRoot}/package.json\n`));
    const runStep = vi.fn();
    await withMockedPlatform("freebsd", async () => {
      await expect(update(params.installTarget, runStep)).rejects.toMatchObject({
        reason: "pkg-owned-install",
      });
    });
    expect(runStep).not.toHaveBeenCalled();
  });
});
