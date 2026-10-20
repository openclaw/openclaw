import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "../../scripts/lib/package-dist-inventory-contract.mts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { withTempDirSync } from "../../src/test-helpers/temp-dir.js";

const repoRoot = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const writerUrl = resolveRuntimeWorkerUrl(scriptProcessEntrypoints.packageDistInventory);
const writerPath = fileURLToPath(writerUrl);
const writerRoot = path.resolve(path.dirname(writerPath), "..");
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), "utf8");
const distFiles = (root: string) => fs.readdirSync(path.join(root, "dist")).toSorted();
const inventory = PACKAGE_DIST_INVENTORY_RELATIVE_PATH;
const contentInventory = PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH;
const pending = PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH;

function withPackageFixture(run: (packageRoot: string) => void) {
  withTempDirSync({ prefix: "openclaw-path-alias-inventory-" }, (packageRoot) => {
    fs.mkdirSync(path.join(packageRoot, "dist"));
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(packageRoot, "dist/entry.js"), "export {};\n");
    run(packageRoot);
  });
}

function runNode(packageRoot: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [...resolveRuntimeWorkerArgv(writerUrl).slice(0, -1), ...args],
    {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        // Source fallback resolves workspace aliases independently of the fixture cwd.
        TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
        TSX_DISABLE_CACHE: "1",
        pm_exec_path: writerPath,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe("write-package-dist-inventory direct entry", () => {
  it.each(["canonical", "directory alias"])("writes both artifacts via %s", (entry) => {
    withPackageFixture((packageRoot) => {
      let scriptPath = writerPath;
      if (entry === "directory alias") {
        const sourceAlias = path.join(packageRoot, "source-alias");
        fs.symlinkSync(writerRoot, sourceAlias, process.platform === "win32" ? "junction" : "dir");
        scriptPath = path.join(sourceAlias, "scripts", path.basename(writerPath));
      }

      runNode(packageRoot, [scriptPath]);

      expect(JSON.parse(read(packageRoot, inventory))).toEqual(["dist/entry.js", contentInventory]);
      expect(read(packageRoot, pending)).toBe("pending\n");
      expect(distFiles(packageRoot)).toEqual(
        ["entry.js", path.basename(inventory), path.basename(contentInventory)].toSorted(),
      );
    });
  });

  it.each([
    { entry: "no argv", seeded: false },
    { entry: "same basename", seeded: true },
  ])("stays inert with $entry, existing artifacts=$seeded and PM2 hints", ({ entry, seeded }) => {
    withPackageFixture((packageRoot) => {
      const expected: Record<string, string> = { "entry.js": "export {};\n" };
      if (seeded) {
        expected[path.basename(inventory)] = '["dist/previous.js"]\n';
        for (const [name, content] of Object.entries(expected)) {
          fs.writeFileSync(path.join(packageRoot, "dist", name), content);
        }
        fs.writeFileSync(path.join(packageRoot, pending), "existing marker\n");
      }
      const importSource = `await import(${JSON.stringify(pathToFileURL(writerPath).href)});\n`;
      const importerPath = path.join(packageRoot, path.basename(writerPath));
      fs.writeFileSync(importerPath, importSource);
      runNode(
        packageRoot,
        entry === "no argv" ? ["--input-type=module", "--eval", importSource] : [importerPath],
      );

      const actual = Object.fromEntries(
        distFiles(packageRoot).map((name) => [name, read(packageRoot, `dist/${name}`)]),
      );
      expect(actual).toEqual(expected);
      const markerPath = path.join(packageRoot, pending);
      if (seeded) {
        expect(fs.readFileSync(markerPath, "utf8")).toBe("existing marker\n");
      } else {
        expect(fs.existsSync(markerPath)).toBe(false);
      }
    });
  });
});
