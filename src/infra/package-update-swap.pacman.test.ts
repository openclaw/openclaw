import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("preserves the live package when pacman takes ownership during service preparation", async () => {
  const { params, packageRoot, launcher } = await createPackageSwapFixture(
    dirs.make("pacman-swap-"),
  );
  const access = fs.access.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (file !== "/usr/bin/pacman") {
      return access(file, mode);
    }
  });
  let owned = false;
  vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv) => ({
    stdout: owned ? "openclaw\n" : "",
    stderr: owned ? "" : `error: No package owns ${argv.at(-1)}\n`,
    code: owned ? 0 : 1,
    signal: null,
    killed: false,
    termination: "exit",
  }));
  const onLiveMutation = vi.fn();
  await withMockedPlatform("linux", async () => {
    await expect(
      swapStagedPackageInstall({
        ...params,
        beforeActivate: async () => {
          owned = true;
        },
        onLiveMutation,
      }),
    ).rejects.toMatchObject({ cause: { reason: "unmanaged-package-install" } });
  });
  expect(owned).toBe(true);
  expect(onLiveMutation).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
    '"version":"1.0.0"',
  );
  expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
});
