import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const directories = useAutoCleanupTempDirTracker(afterAll);

it("keeps late imports on the old generation through replacement and CLI teardown", async () => {
  const base = directories.make("openclaw-retained-imports-");
  const root = path.join(base, "install");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "fixture"), { recursive: true });
  const files = {
    "package.json": '{"name":"openclaw","type":"module"}',
    "node_modules/fixture/package.json": '{"type":"module","exports":"./index.js"}',
    "node_modules/fixture/index.js": 'export default "old dependency";',
    "dist/shared.mjs": "export const shared = {};\n",
    "dist/late-old-hash.mjs":
      'import dependency from "fixture"; import { shared } from "./shared.mjs"; export { shared }; export const value = dependency; export const url = import.meta.url;',
    "dist/updater.mjs":
      'import { fileURLToPath } from "node:url"; export { shared } from "./shared.mjs"; export const late = () => import("./late-old-hash.mjs"); export const absolute = () => import(fileURLToPath(new URL("./absolute-old-hash.mjs", import.meta.url))); export const cleanup = () => import("./cleanup-old-hash.mjs");',
    "dist/absolute-old-hash.mjs": 'export const value = "old absolute";',
    "dist/cleanup-old-hash.mjs": 'export const value = "cleanup retained";',
    "dist/tool-dependency.mjs": 'export const value = "old tooling";',
    "tooling.mjs": 'export { value } from "./dist/tool-dependency.mjs";',
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, file), content);
  }
  const result = spawnNodeEvalSync(
    `import assert from "node:assert/strict";
     import fs from "node:fs/promises";
     import path from "node:path";
     import { pathToFileURL } from "node:url";
     import { withRetainedUpdateRuntime } from ${JSON.stringify(new URL("./update-retained-runtime.ts", import.meta.url).href)};
     const root = ${JSON.stringify(root)};
     const url = pathToFileURL(path.join(root, "dist/updater.mjs")).href;
     const updater = await import(url);
     await withRetainedUpdateRuntime(url, async retain => {
       await retain({ mutationRoots: [root], timeoutMs: 30000, assertCurrent() {} });
       await fs.rm(path.join(root, "dist"), { recursive: true });
       await fs.mkdir(path.join(root, "dist"));
       await fs.writeFile(path.join(root, "dist/late-new-hash.mjs"), 'export const value = "new build";');
       await fs.writeFile(path.join(root, "dist/shared.mjs"), 'throw new Error("new singleton loaded by old updater");');
       await fs.writeFile(path.join(root, "dist/tool-dependency.mjs"), 'export const value = "new tooling";');
       await fs.rm(path.join(root, "node_modules/fixture/index.js"));
       await fs.writeFile(path.join(root, "node_modules/fixture/index.js"), 'export default "new dependency";');
       const late = await updater.late();
       assert.equal(late.value, "old dependency");
       assert.equal(late.shared, updater.shared);
       assert.equal(late.url, pathToFileURL(path.join(root, "dist/late-old-hash.mjs")).href);
       assert.equal((await updater.absolute()).value, "old absolute");
       assert.equal((await import(pathToFileURL(path.join(root, "tooling.mjs")).href)).value, "new tooling");
     });
     assert.equal((await updater.cleanup()).value, "cleanup retained");
     assert.equal((await import(pathToFileURL(path.join(root, "dist/late-new-hash.mjs")).href)).value, "new build");`,
    {
      imports: [import.meta.resolve("tsx")],
      input: "",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: base,
        TMPDIR: base,
        OPENCLAW_STATE_DIR: path.join(base, "state"),
        OPENCLAW_CONFIG_PATH: path.join(base, "state/openclaw.json"),
        XDG_CACHE_HOME: path.join(base, "cache"),
        OPENCLAW_LOG_LEVEL: "silent",
      },
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
