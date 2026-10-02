import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["symlink", "directory"] as const)(
  "updates the npm package without traversing a historical package backup %s",
  async (kind) => {
    const base = await fs.realpath(dirs.make("retained-package-backup-"));
    const { params, globalRoot, packageRoot: installed } = await createPackageSwapFixture(base);
    const dependency = path.join(globalRoot, "fixture");
    const backupName = ".openclaw.package-backup-123-1700000000000";
    const backup = path.join(globalRoot, backupName);
    const checkout = kind === "symlink" ? path.join(base, "checkout") : backup;
    for (const directory of [
      path.join(installed, "dist"),
      dependency,
      path.join(checkout, ".claude"),
      path.join(checkout, ".agents/skills"),
      path.join(checkout, "node_modules"),
    ]) {
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(
      path.join(installed, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "1.0.0",
        type: "module",
        dependencies: { fixture: "1.0.0" },
      }),
    );
    await fs.writeFile(
      path.join(installed, "dist/updater.mjs"),
      'export { value } from "fixture";',
    );
    await fs.writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "fixture", type: "module", exports: "./index.js" }),
    );
    await fs.writeFile(path.join(dependency, "index.js"), 'export const value = "hoisted";');
    await fs.writeFile(path.join(checkout, "package.json"), '{"name":"openclaw"}');
    const sentinel = path.join(checkout, ".agents/skills/keep.txt");
    await fs.writeFile(sentinel, "operator checkout");
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
    await fs.mkdir(`${backup}.databases`);
    await fs.writeFile(path.join(`${backup}.databases`, "snapshot.sqlite"), "recovery data");
    const asset = path.join("dist", backupName, "asset.txt");
    await fs.mkdir(path.dirname(path.join(installed, asset)), { recursive: true });
    await fs.writeFile(path.join(installed, asset), "runtime asset outside module owner");
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
      expect(await fs.readFile(path.join(retainedModules, "openclaw", asset), "utf8")).toBe(
        "runtime asset outside module owner",
      );
      expect(await fs.readFile(sentinel, "utf8")).toBe("operator checkout");
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
      expect(
        JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8")),
      ).toMatchObject({
        version: "2.0.0",
      });
    });
    if (kind === "symlink") {
      expect(await fs.readFile(sentinel, "utf8")).toBe("operator checkout");
      expect(await fs.readlink(path.join(checkout, ".claude/skills"))).toBe("../.agents/skills");
    }
    expect(await fs.readFile(path.join(`${backup}.databases`, "snapshot.sqlite"), "utf8")).toBe(
      "recovery data",
    );
    await expect(fs.lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
