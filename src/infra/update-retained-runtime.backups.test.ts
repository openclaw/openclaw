import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { pkgQueryResult } from "./update-freebsd-pkg-ownership.test-support.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(
  (["symlink", "directory"] as const).flatMap((kind) =>
    (["missing", "failed"] as const).map((probe) => ({ kind, probe })),
  ),
)(
  "updates the npm package without traversing a historical package backup $kind when pacman is $probe",
  async ({ kind, probe }) => {
    mockProcessPlatform("linux");
    vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
      pkgQueryResult(
        "",
        probe === "missing"
          ? {
              code: null,
              termination: "error",
              error: Object.assign(new Error("pacman unavailable"), { code: "ENOENT" }),
            }
          : { code: 1 },
      ),
    );
    const base = await fs.realpath(dirs.make("retained-package-backup-"));
    const { params, globalRoot, packageRoot: installed } = await createPackageSwapFixture(base);
    async function writeTree(root: string, files: Record<string, string>) {
      for (const [file, content] of Object.entries(files)) {
        const destination = path.join(root, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content);
      }
    }
    const read = (file: string) => fs.readFile(file, "utf8");
    const dependency = path.join(globalRoot, "fixture");
    const backupName = ".openclaw.package-backup-123-1700000000000";
    const backup = path.join(globalRoot, backupName);
    const checkout = kind === "symlink" ? path.join(base, "checkout") : backup;
    const asset = path.join("dist", backupName, "asset.txt");
    const assetContent = "runtime asset outside module owner";
    await writeTree(installed, {
      "package.json": JSON.stringify({
        name: "openclaw",
        version: "1.0.0",
        type: "module",
        dependencies: { fixture: "1.0.0" },
      }),
      "dist/updater.mjs": 'export { value } from "fixture";',
      [asset]: assetContent,
    });
    await writeTree(dependency, {
      "package.json": JSON.stringify({ name: "fixture", type: "module", exports: "./index.js" }),
      "index.js": 'export const value = "hoisted";',
    });
    await writeTree(checkout, {
      "package.json": '{"name":"openclaw"}',
      ".agents/skills/keep.txt": "operator checkout",
    });
    const sentinel = path.join(checkout, ".agents/skills/keep.txt");
    await fs.mkdir(path.join(checkout, ".claude"));
    await fs.mkdir(path.join(checkout, "node_modules"));
    await fs.symlink("../.agents/skills", path.join(checkout, ".claude/skills"), "dir");
    await fs.symlink(checkout, path.join(checkout, "node_modules/openclaw"), "junction");
    if (kind === "symlink") {
      await fs.symlink(checkout, backup, "junction");
    }
    await fs.symlink(
      checkout,
      path.join(globalRoot, ".openclaw-package-backup-124-1700000000000"),
      "junction",
    );
    await writeTree(`${backup}.databases`, { "snapshot.sqlite": "recovery data" });
    const original = await fs.lstat(backup, { bigint: true });
    const moduleUrl = pathToFileURL(path.join(installed, "dist/updater.mjs"));
    await withRetainedUpdateRuntime(moduleUrl.href, async (retain) => {
      await retain({
        mutationRoots: [installed],
        installTarget: { manager: "npm", command: "npm", globalRoot, packageRoot: installed },
        timeoutMs: 30_000,
        assertCurrent() {},
      });
      const retainedUrl = captureRuntimeWorkerSource(moduleUrl).moduleUrl;
      expect(retainedUrl.href).not.toBe(moduleUrl.href);
      const retainedModules = path.resolve(path.dirname(fileURLToPath(retainedUrl)), "../..");
      expect((await fs.readdir(retainedModules)).toSorted()).toEqual(["fixture", "openclaw"]);
      expect((await import(retainedUrl.href)).value).toBe("hoisted");
      expect(await read(path.join(retainedModules, "openclaw", asset))).toBe(assetContent);
      expect(await read(sentinel)).toBe("operator checkout");
      expect(await fs.lstat(backup, { bigint: true })).toMatchObject({
        dev: original.dev,
        ino: original.ino,
      });
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (value) => {
          transaction = value;
        },
      });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      expect(await transaction!.complete({ activationVerified: true }, () => {})).toBeUndefined();
      expect(JSON.parse(await read(path.join(installed, "package.json")))).toMatchObject({
        version: "2.0.0",
      });
    });
    if (kind === "symlink") {
      expect(await read(sentinel)).toBe("operator checkout");
      expect(await fs.readlink(path.join(checkout, ".claude/skills"))).toBe("../.agents/skills");
    }
    expect(await read(path.join(`${backup}.databases`, "snapshot.sqlite"))).toBe("recovery data");
    await expect(fs.lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
