import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseTestExclusions } from "../../scripts/frv-test-exclusions.mjs";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("frozen-target test exclusions", () => {
  it("accepts exact paths in their declared lane", () => {
    expect(parseTestExclusions("[]", "plugins")).toEqual([]);
    expect(parseTestExclusions('["src/plugins/nested/retry.test.ts"]', "plugins")).toEqual([
      "src/plugins/nested/retry.test.ts",
    ]);
    expect(
      parseTestExclusions(
        '["extensions/example/retry.test.ts","extensions/example/view.test.tsx"]',
        "extensions",
      ),
    ).toEqual(["extensions/example/retry.test.ts", "extensions/example/view.test.tsx"]);
  });

  it.each([
    { json: "{", scope: "plugins" },
    { json: "{}", scope: "plugins" },
    { json: '["src/plugins/*.test.ts"]', scope: "plugins" },
    { json: '["src/plugins/../agents/retry.test.ts"]', scope: "plugins" },
    { json: '["/src/plugins/retry.test.ts"]', scope: "plugins" },
    { json: '["src/plugins/retry.test.js"]', scope: "plugins" },
    { json: '["src/plugins/retry.test.ts",42]', scope: "plugins" },
    { json: '["extensions/example/retry.test.ts"]', scope: "plugins" },
    { json: '["src/plugins/retry.test.ts"]', scope: "extensions" },
    { json: JSON.stringify(["extensions\\example\\retry.test.ts"]), scope: "extensions" },
  ])("rejects paths outside the exact $scope contract: $json", ({ json, scope }) => {
    expect(() => parseTestExclusions(json, scope)).toThrow();
  });

  it("excludes exact files from native inline projects and restores candidate configs", async () => {
    const root = tempDirs.make("frv-test-exclusions-");
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    };
    write("package.json", '{"type":"module"}\n');
    fs.symlinkSync(
      fs.realpathSync(path.join(repoRoot, "node_modules")),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const pluginConfig = "test/vitest/vitest.plugins.config.ts";
    const extensionConfig = "test/vitest/vitest.extensions.config.ts";
    const target = "src/plugins/first/retry.test.ts";
    const sibling = "src/plugins/second/retry.test.ts";
    const native = "src/plugins/native-loader.test.ts";
    const outsideSelection = "src/plugins/not-selected.test.ts";
    const extension = "extensions/example/retry.test.ts";
    const extensionOutsideSelection = "extensions/unselected/retry.test.ts";
    for (const file of [
      target,
      sibling,
      native,
      outsideSelection,
      extension,
      extensionOutsideSelection,
    ]) {
      write(file, "export {};\n");
    }
    const common = {
      root,
      dir: path.join(root, "src/plugins"),
      include: ["**/*.test.ts"],
      exclude: ["not-selected.test.ts"],
    };
    const project = (name: string, filters: { include?: string[]; exclude?: string[] }) => ({
      extends: false,
      test: { ...common, name, ...filters },
    });
    write(
      pluginConfig,
      `// Preserve candidate bytes, including CRLF.\r\nexport const nativeFiles = [${JSON.stringify(native)}];\r\nexport default ${JSON.stringify(
        {
          test: {
            ...common,
            projects: [
              project("plugins", { exclude: [...common.exclude, "native-loader.test.ts"] }),
              project("plugins-native-loader", { include: ["native-loader.test.ts"] }),
            ],
          },
        },
      )};\r\n`,
    );
    write(
      extensionConfig,
      `import fs from "node:fs";
const config = ${JSON.stringify({
        test: {
          root,
          dir: path.join(root, "extensions"),
          include: ["**/*.test.ts"],
          exclude: [],
        },
      })};
if (process.env.OPENCLAW_VITEST_INCLUDE_FILE) {
  config.test.include = JSON.parse(fs.readFileSync(process.env.OPENCLAW_VITEST_INCLUDE_FILE, "utf8"))
    .map(pattern => pattern.slice("extensions/".length));
}
export default config;\n`,
    );
    const probe = path.join(root, "probe.mjs");
    write(
      "probe.mjs",
      `import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateTestExclusions } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/frv-test-exclusions.mjs")).href)};

const root = ${JSON.stringify(root)};
const configs = ${JSON.stringify([pluginConfig, extensionConfig])};
const excluded = ${JSON.stringify([target, native, extension])};
const sibling = ${JSON.stringify(sibling)};
const extensionOutsideSelection = ${JSON.stringify(extensionOutsideSelection)};
const original = ${JSON.stringify([pluginConfig, extensionConfig].map((config) => fs.readFileSync(path.join(root, config), "base64")))}.map(bytes => Buffer.from(bytes, "base64"));
const candidateRequire = createRequire(path.join(root, "package.json"));
const { createVitest } = await import(pathToFileURL(candidateRequire.resolve("vitest/node")).href);

async function discover(config, exclude = []) {
  const runner = await createVitest({
    root, config: path.join(root, config), watch: false, run: true, reporters: [], cliExclude: exclude,
  });
  try {
    return (await runner.globTestSpecifications())
      .map(spec => path.relative(root, spec.moduleId).replaceAll(path.sep, "/")).sort();
  } finally {
    await runner.close();
  }
}

function assertRestored() {
  configs.forEach((config, index) => {
    assert.deepEqual(fs.readFileSync(path.join(root, config)), original[index]);
  });
}

const pluginBaseline = [...excluded.slice(0, 2), sibling].sort();
const mode = process.argv[2];
if (mode) {
  if (mode === "unaffected") {
    assertRestored();
  } else if (mode === "extensions") {
    assert.deepEqual(await discover(configs[0]), pluginBaseline);
    assert.deepEqual(await discover(configs[1]), [extensionOutsideSelection]);
  } else {
    assert.deepEqual(fs.readFileSync(path.join(root, configs[1])), original[1]);
    assert.deepEqual(await discover(configs[0]), mode === "single" ? [excluded[1], sibling].sort() : [sibling]);
    const pluginExports = await import(pathToFileURL(path.join(root, configs[0])).href);
    assert.deepEqual(pluginExports.nativeFiles, [excluded[1]]);
  }
  if (mode === "conflict") {
    fs.writeFileSync(path.join(root, configs[0]), "// concurrent config owner");
    console.error("candidate failure before cleanup");
    process.exit(23);
  }
  process.exit(mode === "failure" ? 23 : 0);
}

// The old workflow's root exclude options never reached the extends:false leaves.
assert.deepEqual(await discover(configs[0]), pluginBaseline);
assert.deepEqual(await discover(configs[0], ["**/retry.test.ts", "**/native-loader.test.ts"]), pluginBaseline);
assert.deepEqual(await discover(configs[1]), [excluded[2], extensionOutsideSelection]);
await validateTestExclusions({ paths: excluded, configs, cwd: root });

const selectedExtension = [{ config: configs[1], includePatterns: [excluded[2]] }];
const inheritedIncludeFile = process.env.OPENCLAW_VITEST_INCLUDE_FILE;
await validateTestExclusions({ paths: [excluded[2]], configs: selectedExtension, cwd: root });
const rejectsExclusion = (file, selectedConfigs = configs) => assert.rejects(
  () => validateTestExclusions({ paths: [file], configs: selectedConfigs, cwd: root }),
  error => error instanceof Error && error.message.includes(file),
);
await rejectsExclusion(extensionOutsideSelection, selectedExtension);
assert.equal(process.env.OPENCLAW_VITEST_INCLUDE_FILE, inheritedIncludeFile);

for (const invalid of ["src/plugins/missing.test.ts", ${JSON.stringify(outsideSelection)}]) {
  await rejectsExclusion(invalid);
}
await rejectsExclusion(excluded[2], [configs[0]]);
assertRestored();

const adapter = ${JSON.stringify(path.join(repoRoot, "scripts/frv-test-exclusions.mjs"))};
const commandEnv = {
  ...process.env,
  FRV_TEST_EXCLUDE_SCOPE: "plugins",
  FRV_TEST_EXCLUDE_PATHS_JSON: JSON.stringify(excluded.slice(0, 2)),
  FRV_TEST_CONFIGS_JSON: JSON.stringify(configs),
};
const runAdapter = (args, env = commandEnv) => spawnSync(process.execPath, [adapter, "run", "--", ...args], {
  cwd: root, env, encoding: "utf8",
});
for (const [mode, scope, paths, selectedConfigs, expectedExit] of [
  ["single", "plugins", [excluded[0]], configs, 0],
  ["unaffected", "plugins", excluded.slice(0, 2), [configs[1]], 0],
  ["plugins", "plugins", excluded.slice(0, 2), configs, 0],
  ["extensions", "extensions", [excluded[2]], configs, 0],
  ["failure", "plugins", excluded.slice(0, 2), configs, 23],
]) {
  const result = runAdapter([process.execPath, process.argv[1], mode], {
    ...commandEnv,
    FRV_TEST_EXCLUDE_SCOPE: scope,
    FRV_TEST_EXCLUDE_PATHS_JSON: JSON.stringify(paths),
    FRV_TEST_CONFIGS_JSON: JSON.stringify(selectedConfigs),
  });
  assert.equal(result.status, expectedExit, mode + ": " + result.stderr);
  assertRestored();
}
assert.deepEqual(await discover(configs[0]), pluginBaseline);

const failedSpawn = runAdapter([path.join(root, "missing-command")]);
assert.equal(failedSpawn.status, 1, failedSpawn.stderr);
assert.match(failedSpawn.stderr, /ENOENT/);
assert.ok(failedSpawn.stderr.includes(path.join(root, "missing-command")));
assertRestored();

if (process.platform !== "win32") {
  const child = spawn(process.execPath, [adapter, "run", "--", process.execPath, "-e",
    'process.on("SIGTERM", () => process.exit(0)); console.log("ready"); process.stdin.resume();',
  ], { cwd: root, env: commandEnv, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let signalled = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!signalled && output.includes("ready")) {
      signalled = true;
      child.kill("SIGTERM");
    }
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(signalled, true);
  assert.equal(exitCode, 143);
  assertRestored();
}

const secondConfig = "test/vitest/vitest.additional.config.ts";
fs.writeFileSync(path.join(root, secondConfig), original[0]);
const conflicted = runAdapter([process.execPath, process.argv[1], "conflict"], {
  ...commandEnv, FRV_TEST_CONFIGS_JSON: JSON.stringify([secondConfig, ...configs]),
});
assert.equal(conflicted.status, 1, conflicted.stderr);
assert.match(conflicted.stderr, /candidate failure before cleanup/);
assert.match(conflicted.stderr, /Command exited with status 23/);
assert.match(conflicted.stderr, /Frozen-target config changed during execution; original retained at/);
assert.equal(fs.readFileSync(path.join(root, configs[0]), "utf8"), "// concurrent config owner");
assert.deepEqual(fs.readFileSync(path.join(root, configs[1])), original[1]);
assert.deepEqual(fs.readFileSync(path.join(root, secondConfig)), original[0]);
const retained = fs.readdirSync(path.join(root, "test/vitest")).filter(name => name.startsWith(".frv-source-"));
assert.equal(retained.length, 1);
const retainedPath = path.join(root, "test/vitest", retained[0]);
assert.ok(conflicted.stderr.includes(retainedPath));
assert.deepEqual(fs.readFileSync(retainedPath), original[0]);
console.log("exact exclusions and restoration verified");
`,
    );
    const result = await runNodeScript(
      probe,
      { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", OPENCLAW_VITEST_INCLUDE_FILE: "" },
      DEFAULT_VITEST_TEST_TIMEOUT_MS,
      { cwd: root, requireProcessTreeExit: process.platform !== "win32" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("exact exclusions and restoration verified");
  });
});
