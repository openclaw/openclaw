import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform !== "win32").each([false, true])(
  "handles a relinked launcher during verification (foreign=%s)",
  async (foreign) => {
    const base = dirs.make("package-launcher-relink-");
    const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
    const target = "../lib/node_modules/openclaw/openclaw.mjs";
    const replacement = foreign ? "../lib/node_modules/foreign/cli.mjs" : target;
    await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), "old launcher\n");
    await fs.unlink(launcher);
    await fs.symlink(target, launcher);
    let injected = false;
    const readlink = fs.readlink.bind(fs);
    vi.spyOn(fs, "readlink").mockImplementation(async (...args) => {
      const value = await readlink(...args);
      if (String(args[0]) === launcher && !injected) {
        injected = true;
        await fs.rename(launcher, `${launcher}.original`);
        await fs.symlink(replacement, launcher);
      }
      return value;
    });
    const onLiveMutation = vi.fn();
    const result = await swapStagedPackageInstall({ ...params, onLiveMutation });
    expect(injected).toBe(true);
    if (foreign) {
      expect(result.status).toBe("failed");
      expect(result.step.stderrTail).toContain(target);
      expect(result.step.stderrTail).toContain(replacement);
      expect(onLiveMutation).not.toHaveBeenCalled();
      expect(await fs.readlink(launcher)).toBe(replacement);
      expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
    } else {
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      expect(await fs.readFile(launcher, "utf8")).toBe("candidate launcher\n");
    }
  },
);

it.runIf(process.platform !== "win32")(
  "verifies launcher backup bytes despite rewritten metadata and restores them",
  async () => {
    const { params, launcher } = await createPackageSwapFixture(
      dirs.make("package-launcher-metadata-"),
    );
    const rename = fs.rename.bind(fs);
    let injected = false;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      if (String(args[1]).includes(".openclaw.shim-backup-") && !injected) {
        injected = true;
        await fs.chmod(args[1], 0o751);
      }
    });
    const result = await swapStagedPackageInstall({
      ...params,
      postVerifyStep: async () => ({
        name: "verification",
        command: "verify",
        cwd: params.stage.prefix,
        durationMs: 0,
        exitCode: 1,
      }),
    });
    expect(injected).toBe(true);
    expect(result).toMatchObject({ status: "failed", packageRollbackVerified: true });
    expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
  },
);
