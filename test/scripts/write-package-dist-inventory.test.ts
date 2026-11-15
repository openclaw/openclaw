import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH as contentInventory,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH as inventory,
} from "../../scripts/lib/package-dist-inventory-contract.mts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH as pending } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const writerUrl = resolveRuntimeWorkerUrl(scriptProcessEntrypoints.packageDistInventory);
const writerPath = fileURLToPath(writerUrl);
const writerRoot = path.resolve(path.dirname(writerPath), "..");
const nodeArgs = resolveRuntimeWorkerArgv(writerUrl).slice(0, -1);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
const file = (name: string) => path.join(root, name);
const read = (name: string) => fs.readFileSync(file(name), "utf8");
const write = (name: string, contents: string) => fs.writeFileSync(file(name), contents);
const distFiles = () => fs.readdirSync(file("dist")).toSorted();
beforeEach(() => {
  root = tempDirs.make("openclaw-path-alias-inventory-");
  fs.mkdirSync(file("dist"));
  write("package.json", '{"type":"module"}\n');
  write("dist/entry.js", "export {};\n");
});

function runNode(args: string[]) {
  const result = spawnSync(process.execPath, [...nodeArgs, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      // Source fallback resolves workspace aliases independently of the fixture cwd.
      TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
      TSX_DISABLE_CACHE: "1",
      pm_exec_path: writerPath,
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

it.each(["canonical", "directory alias"])("writes both artifacts via %s", (entry) => {
  let scriptPath = writerPath;
  if (entry === "directory alias") {
    const sourceAlias = file("source-alias");
    fs.symlinkSync(writerRoot, sourceAlias, process.platform === "win32" ? "junction" : "dir");
    scriptPath = path.join(sourceAlias, "scripts", path.basename(writerPath));
  }

  runNode([scriptPath]);

  expect(JSON.parse(read(inventory))).toEqual(["dist/entry.js", contentInventory]);
  expect(read(pending)).toBe("pending\n");
  expect(distFiles()).toEqual(
    ["entry.js", path.basename(inventory), path.basename(contentInventory)].toSorted(),
  );
});

it.each([false, true])("imports stay inert despite PM2 hints (seeded=%s)", (seeded) => {
  const expected: Record<string, string> = { "entry.js": "export {};\n" };
  if (seeded) {
    const previous = '["dist/previous.js"]\n';
    expected[path.basename(inventory)] = previous;
    write(inventory, previous);
    write(pending, "existing marker\n");
  }
  const importSource = `await import(${JSON.stringify(pathToFileURL(writerPath).href)});\n`;
  const importerPath = file(path.basename(writerPath));
  fs.writeFileSync(importerPath, importSource);
  runNode(seeded ? [importerPath] : ["--input-type=module", "--eval", importSource]);

  const actual = Object.fromEntries(distFiles().map((name) => [name, read(`dist/${name}`)]));
  expect(actual).toEqual(expected);
  if (seeded) {
    expect(read(pending)).toBe("existing marker\n");
  } else {
    expect(fs.existsSync(file(pending))).toBe(false);
  }
});
