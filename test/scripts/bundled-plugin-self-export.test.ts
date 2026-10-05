import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildExternalPluginLocalDist } from "../../scripts/build-external-plugin-local-dist.mts";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("loads the public Crabbox self-export and its compiled dependencies from installed roots", async () => {
  const root = fs.realpathSync(tempDirs.make("bundled-plugin-self-export-"));
  const plugin = path.join(root, "extensions", "crabbox");
  fs.mkdirSync(path.join(plugin, "src"), { recursive: true });
  const actualPackage = JSON.parse(fs.readFileSync("extensions/crabbox/package.json", "utf8"));
  const sourcePackage = {
    name: actualPackage.name,
    version: actualPackage.version,
    type: actualPackage.type,
    exports: { ...actualPackage.exports, "./notice": "./notice.json", "./blocked": null },
    openclaw: { extensions: ["./index.ts"], release: { publishToNpm: true } },
  };
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      version: "1.0.0",
      files: ["dist/**", "!dist/extensions/crabbox/**"],
    }),
  );
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify(sourcePackage));
  fs.writeFileSync(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({ id: "crabbox", configSchema: { type: "object" } }),
  );
  fs.writeFileSync(path.join(plugin, "index.ts"), "export default {id:'crabbox',register(){}};\n");
  fs.writeFileSync(
    path.join(plugin, "cli-runtime-api.ts"),
    `
    export { binary } from './src/crabbox-binary.js';
    export async function createCrabboxOfflineRuntimeSetup() {
      return (await import('./src/installer.js')).setup();
    }
  `,
  );
  fs.writeFileSync(
    path.join(plugin, "src", "crabbox-binary.ts"),
    "export const binary: string = 'compiled-binary';\n",
  );
  fs.writeFileSync(
    path.join(plugin, "src", "installer.ts"),
    "export function setup(): string { return 'compiled-installer'; }\n",
  );
  await buildExternalPluginLocalDist({ repoRoot: root, env: {}, logLevel: "silent" });
  copyBundledPluginMetadata({ repoRoot: root, env: {} });
  stageBundledPluginRuntime({ repoRoot: root });
  // The installed consumer gets its root from discovery; both package roots must be usable.
  const result = execFileSync(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "-e",
      `
    import {createRequire} from 'node:module';
    import {pathToFileURL} from 'node:url';
    import path from 'node:path';
    const results=[];
    for(const dir of ['extensions/crabbox','dist/extensions/crabbox']) {
      const self=createRequire(path.resolve(dir,'package.json'));
      const resolved=self.resolve('@openclaw/crabbox-provider/cli-runtime-api.js');
      const api=await import(pathToFileURL(resolved).href);
      results.push({resolved, binary:api.binary, setup:await api.createCrabboxOfflineRuntimeSetup()});
    }
    console.log(JSON.stringify(results));
  `,
    ],
    { cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" },
  );
  expect(JSON.parse(result)).toEqual([
    {
      resolved: path.join(plugin, "dist", "cli-runtime-api.js"),
      binary: "compiled-binary",
      setup: "compiled-installer",
    },
    {
      resolved: path.join(root, "dist", "extensions", "crabbox", "cli-runtime-api.js"),
      binary: "compiled-binary",
      setup: "compiled-installer",
    },
  ]);
  const emitted = JSON.parse(
    fs.readFileSync(path.join(root, "dist/extensions/crabbox/package.json"), "utf8"),
  );
  expect(emitted.exports["./notice"]).toBe("./notice.json");
  expect(emitted.exports["./blocked"]).toBeNull();
  expect(JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8"))).toEqual(
    sourcePackage,
  );
});
