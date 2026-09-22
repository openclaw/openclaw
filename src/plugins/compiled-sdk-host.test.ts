import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCompiledSdkHost } from "./compiled-sdk-host.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);

it("runs only the requested SDK closures from an independent package host", async () => {
  const sourceRoot = tempDirs.make("openclaw-sdk-source-");
  const files = {
    "plugin-sdk/first.js": `
import { createRequire } from "node:module";
import { value } from "../shared.js";
import common from "../common.cjs";
import embedded from "../node_modules/embedded-package/index.cjs";
const require = createRequire(import.meta.url);
const buildInfoPath = "../build-info.json";
const packagePath = "../../package.json";
export const result = value + common.value;
export const embeddedResult = embedded;
export const buildId = require(buildInfoPath).buildId;
export const packageName = require(packagePath).name;
export const workerUrl = new URL("../worker.js", import.meta.url);
export const optionalUrl = new URL("../absent.js", import.meta.url);
export const load = () => import("../dynamic.js").then((module) => module.value);
`,
    "plugin-sdk/second.js": 'export { value } from "../shared.js";',
    "shared.js": "export const value = 2;",
    "common.cjs": 'module.exports = require("./nested.cjs");',
    "nested.cjs": "module.exports = { value: 3 };",
    "dynamic.js": "export const value = 7;",
    "worker.js": "export const value = 11;",
    "node_modules/embedded-package/index.cjs": `
const fs = require("node:fs");
const path = require("node:path");
module.exports = {
  value: require("./child.cjs").value,
  name: require("./package.json").name,
  asset: fs.readFileSync(path.join(__dirname, "assets", "fixture.txt"), "utf8"),
  sibling: require("embedded-sibling").value,
};
`,
    "node_modules/embedded-package/child.cjs": "module.exports = { value: 13 };",
    "node_modules/embedded-package/package.json": JSON.stringify({ name: "embedded-package" }),
    "node_modules/embedded-package/assets/fixture.txt": "embedded asset",
    "node_modules/embedded-sibling/package.json": JSON.stringify({ main: "index.cjs" }),
    "node_modules/embedded-sibling/index.cjs": "module.exports = { value: 17 };",
    "build-info.json": JSON.stringify({ buildId: "fixture-build" }),
    "unrelated.js": 'throw new Error("unrelated SDK output must remain absent");',
  };
  for (const [relative, source] of Object.entries(files)) {
    const filename = path.join(sourceRoot, "dist", relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
  const entrypoint = (name: string) => ({
    root: sourceRoot,
    currentModuleUrl: import.meta.url,
    sourceWorkerName: `../plugin-sdk/${name}`,
    distWorkerPath: `plugin-sdk/${name}.js`,
  });
  const host = createCompiledSdkHost([entrypoint("first"), entrypoint("second")], (prefix) =>
    tempDirs.make(prefix),
  );
  if (!host) {
    throw new Error("Expected a compiled SDK host");
  }
  const narrowHost = createCompiledSdkHost([entrypoint("second")], (prefix) =>
    tempDirs.make(prefix),
  );
  if (!narrowHost) {
    throw new Error("Expected a compiled SDK host without embedded dependencies");
  }
  expect(fs.existsSync(path.join(narrowHost, "dist/node_modules"))).toBe(false);
  expect(require(path.join(narrowHost, "dist/plugin-sdk/second.js"))).toMatchObject({ value: 2 });
  expect(fs.existsSync(path.join(host, "dist/unrelated.js"))).toBe(false);
  expect(fs.existsSync(path.join(host, "dist/absent.js"))).toBe(false);
  // A host retains its own native files and package identity, not aliases into the source tree.
  fs.writeFileSync(path.join(sourceRoot, "dist/shared.js"), "export const value = 99;");
  const first = require(path.join(host, "dist/plugin-sdk/first.js")) as {
    result: number;
    embeddedResult: { value: number; name: string; asset: string; sibling: number };
    buildId: string;
    packageName: string;
    workerUrl: URL;
    load: () => Promise<number>;
  };
  expect(first.result).toBe(5);
  expect(first.embeddedResult).toEqual({
    value: 13,
    name: "embedded-package",
    asset: "embedded asset",
    sibling: 17,
  });
  expect(first.buildId).toBe("fixture-build");
  expect(first.packageName).toBe("openclaw");
  await expect(first.load()).resolves.toBe(7);
  expect(require(fileURLToPath(first.workerUrl))).toMatchObject({ value: 11 });
  expect(require(path.join(host, "dist/plugin-sdk/second.js"))).toMatchObject({ value: 2 });
});
