import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  const access = fs.access.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (file !== "/usr/bin/pacman") {
      return access(file, mode);
    }
  });
});

it.each([
  { entry: "package", phase: "during" },
  { entry: "launcher", phase: "before" },
  { entry: "launcher", phase: "during" },
])(
  "preserves a pacman-owned $entry acquired $phase service preparation",
  async ({ entry, phase }) => {
    const { params, packageRoot, launcher } = await createPackageSwapFixture(
      dirs.make("pacman-swap-"),
    );
    let owned = phase === "before";
    mockPacmanOwnership(
      (file) =>
        owned && path.basename(file) === (entry === "launcher" ? "openclaw" : "package.json"),
    );
    const onLiveMutation = vi.fn();
    const onTransaction = vi.fn();
    const beforeActivate = vi.fn(async () => {
      owned = true;
    });
    await withMockedPlatform("linux", async () => {
      await expect(
        swapStagedPackageInstall({ ...params, beforeActivate, onLiveMutation, onTransaction }),
      ).rejects.toMatchObject({ cause: { reason: "unmanaged-package-install" } });
    });
    expect(beforeActivate).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    expect(onLiveMutation).not.toHaveBeenCalled();
    expect(onTransaction).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
      '"version":"1.0.0"',
    );
    expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
  },
);

it("retains the candidate and recovery copy when pacman claims a launcher before rollback", async () => {
  let owned = false;
  mockPacmanOwnership((file) => owned && path.basename(file) === "openclaw");
  await withMockedPlatform("linux", async () => {
    const { transaction, packageRoot, launcher } = await createRetainedPackageSwap(
      dirs.make("pacman-rollback-"),
    );
    owned = true;
    await expect(transaction.rollback(() => {})).resolves.toMatchObject({
      exitCode: 1,
      stderrTail: expect.stringContaining("retained for manual recovery"),
    });
    expect(await fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8")).toContain(
      '"version":"1.0.0"',
    );
    expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
      '"version":"2.0.0"',
    );
    expect(await fs.readFile(launcher, "utf8")).toBe("candidate launcher\n");
  });
});

function mockPacmanOwnership(owns: (file: string) => boolean) {
  vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv) => {
    const file = argv.at(-1);
    if (!file) {
      throw new Error("Expected a queried package entry");
    }
    const owned = owns(file);
    return {
      stdout: owned ? "openclaw\n" : "",
      stderr: owned ? "" : `error: No package owns ${file}\n`,
      code: owned ? 0 : 1,
      signal: null,
      killed: false,
      termination: "exit",
    };
  });
}
