import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { UPDATE_PRELOAD_IMPORTS_FILE } from "./update-retained-imports-contract.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), contents);
  }
}

// Bun has no module hooks: its updater preloads the build-listed chunks before
// replacement. Without the list, the same lazy import reaches the replaced tree.
// CI runs this in the Bun launcher task, where a missing Bun fails the test.
it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1").each([
  { listed: true, expected: "old:old-dep:1" },
  { listed: false, expected: "ENOENT" },
])("Bun updater preloads its later imports (listed=$listed)", async ({ listed, expected }) => {
  const base = tempDirs.make("openclaw-retained-preload-");
  const install = path.join(base, "openclaw");
  await fs.mkdir(path.join(install, ".git"), { recursive: true });
  await writeFiles(install, {
    "package.json": '{"name":"openclaw","type":"module"}',
    "dist/updater.mjs": [
      'import { bump } from "./shared.mjs";',
      "bump();",
      'export const later = () => import("./chunk-OLD1234.mjs");',
    ].join("\n"),
    "dist/shared.mjs": "export let count = 0; export function bump() { return ++count; }",
    "dist/chunk-OLD1234.mjs": [
      'import { count } from "./shared.mjs";',
      'import dep from "esm-dep";',
      'export const value = () => ["old", dep, count].join(":");',
    ].join("\n"),
    "node_modules/esm-dep/package.json": '{"name":"esm-dep","type":"module","exports":"./i.js"}',
    "node_modules/esm-dep/i.js": 'export default "old-dep";',
    ...(listed
      ? { [`dist/${UPDATE_PRELOAD_IMPORTS_FILE}`]: '{"chunks":["chunk-OLD1234.mjs"]}' }
      : {}),
  });
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
    const install = ${JSON.stringify(install)};
    const updaterUrl = pathToFileURL(path.join(install, "dist/updater.mjs")).href;
    const { later } = await import(updaterUrl);
    await withRetainedUpdateRuntime(updaterUrl, async (retain) => {
      const metrics = await retain({ mutationRoots: [install], timeoutMs: 30000, assertCurrent() {} });
      console.log("retainedImports=" + metrics.retainedImports);
      // Replacement removes the old hashed chunk and its dependency.
      fs.rmSync(path.join(install, "dist"), { recursive: true });
      fs.rmSync(path.join(install, "node_modules"), { recursive: true });
      fs.mkdirSync(path.join(install, "dist"));
      fs.writeFileSync(path.join(install, "dist/chunk-NEW5678.mjs"), "export const value = () => 'new';");
      try {
        console.log("result=" + (await later()).value());
      } catch (error) {
        console.log("result=" + (error.code ?? error.message));
      }
    });`;
  const result = spawnSync(process.env.BUN_BIN ?? "bun", ["--eval", script], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: base,
      USERPROFILE: base,
      TMPDIR: base,
      OPENCLAW_STATE_DIR: path.join(base, "state"),
      OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
      XDG_CACHE_HOME: path.join(base, "cache"),
      OPENCLAW_LOG_LEVEL: "silent",
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`retainedImports=${listed}`);
  expect(result.stdout).toContain(`result=${expected}`);
});
