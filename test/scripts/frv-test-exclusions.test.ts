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
  it.each([
    ["plugins", []],
    ["plugins", ["src/plugins/nested/retry.test.ts"]],
    ["extensions", ["extensions/example/retry.test.ts", "extensions/example/view.test.tsx"]],
  ] satisfies Array<[string, string[]]>)("accepts exact paths in %s: %j", (scope, paths) => {
    expect(parseTestExclusions(JSON.stringify(paths), scope)).toEqual(paths);
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

  it("adds exclusions after deferred owners without changing inline server ownership", async () => {
    const root = tempDirs.make("frv-deferred-owners-");
    const write = (file: string, content: string) => {
      const absolute = path.join(root, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return absolute;
    };
    const sourceUrl = (file: string) =>
      JSON.stringify(pathToFileURL(path.join(repoRoot, file)).href);
    write("package.json", '{"type":"module"}\n');
    fs.symlinkSync(
      fs.realpathSync(path.join(repoRoot, "node_modules")),
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const pluginExcluded = "src/plugins/first/retry.test.ts";
    const nativeLoader = "src/plugins/bundled-plugin-metadata.public-surfaces.test.ts";
    const pluginSibling = "src/plugins/second/retry.test.ts";
    const extensionExcluded = "extensions/example/retry.test.ts";
    const extensionSibling = "extensions/example/keep.test.ts";
    const inherited = [
      "src/plugins/inherited-blocked.test.ts",
      "extensions/example/inherited-blocked.test.ts",
    ];
    for (const file of [
      pluginExcluded,
      nativeLoader,
      pluginSibling,
      extensionExcluded,
      extensionSibling,
      ...inherited,
      "src/plugins/registry.runtime-config.test.ts",
      "src/plugins/loader.test.ts",
      "src/plugins/first/owner-blocked.test.ts",
      "src/plugins/second/owner-blocked.test.ts",
    ])
      write(file, 'import { vi } from "vitest"; vi.resetModules();\n');
    write("src/plugins/pure.test.ts", "export {};\n");
    const includeFile = write(
      "include.json",
      JSON.stringify([
        `${root.replaceAll(path.sep, "/")}/**/*.test.ts`,
        ...inherited.map((file) => `!${path.join(root, file).replaceAll(path.sep, "/")}`),
      ]),
    );
    const overrideIncludeFile = write(
      "override-include.json",
      JSON.stringify([
        "src/plugins/first/*.test.ts",
        "src/plugins/second/*.test.ts",
        "!src/plugins/first/owner-blocked.test.ts",
      ]),
    );
    const prefix = `
import path from "node:path";
import { createScopedVitestConfig } from ${sourceUrl("test/vitest/vitest.scoped-config.ts")};
const root = ${JSON.stringify(root)}, sourceRoot = ${JSON.stringify(repoRoot)};
const relocate = (config) => ({ ...config, extends: false, root, test: {
  ...config.test, root, dir: path.resolve(root, path.relative(sourceRoot, config.test.dir ?? sourceRoot)),
  runner: undefined, setupFiles: [], maxWorkers: 1,
} });
`;
    const configs = [
      "test/vitest/vitest.owned.config.ts",
      "test/vitest/vitest.shared.config.ts",
      "test/vitest/vitest.override.config.ts",
    ];
    const originals = [
      `${prefix}
import { createPluginsVitestConfig } from ${sourceUrl("test/vitest/vitest.plugins.config.ts")};
import { createExtensionsVitestConfig } from ${sourceUrl("test/vitest/vitest.extensions.config.ts")};
const plugins = createPluginsVitestConfig(process.env);
export default { root, test: { sharedViteServer: true, projects: [
  ...plugins.test.projects, createExtensionsVitestConfig(process.env),
].map(relocate) } };
`,
      `${prefix}
const config = relocate(createScopedVitestConfig(["src/plugins/**/*.test.ts"], {
  dir: "src/plugins", env: process.env, excludeUnitFastTests: false,
}));
export default { ...config, test: { ...config.test, sharedViteServer: true, projects: [
  { plugins: [false, [null, undefined, []]], test: {
    name: "first", include: ["first/*.test.ts"], exclude: ["first/owner-blocked.test.ts"],
  } },
  { test: { name: "second", include: ["second/*.test.ts"], exclude: ["second/owner-blocked.test.ts"] } },
] } };
`,
      `${prefix}
const config = relocate(createScopedVitestConfig(["src/plugins/**/*.test.ts"], {
  dir: "src/plugins", env: { ...process.env, OPENCLAW_VITEST_INCLUDE_FILE: ${JSON.stringify(overrideIncludeFile)} },
  exclude: ["src/plugins/second/retry.test.ts"],
}));
export default { ...config, test: { ...config.test, name: "override",
  exclude: ["second/owner-blocked.test.ts"],
} };
`,
    ];
    configs.forEach((file, index) => write(file, originals[index]!));
    const probe = write(
      "probe.mjs",
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createVitest } from "vitest/node";
const root = ${JSON.stringify(root)}, configs = ${JSON.stringify(configs)};
const originals = ${JSON.stringify(originals)};
const removed = ${JSON.stringify([pluginExcluded, nativeLoader, extensionExcluded])};
const scope = process.argv[2];
const activeRemoved = scope === "plugins" ? removed.slice(0, 2) : scope === "extensions" ? removed.slice(2) : [];
const rows = [
  ${JSON.stringify([
    [pluginExcluded, "plugins"],
    [nativeLoader, "plugins-native-loader"],
    [pluginSibling, "plugins"],
    [extensionExcluded, "extensions"],
    [extensionSibling, "extensions"],
    ["src/plugins/first/owner-blocked.test.ts", "plugins"],
    ["src/plugins/second/owner-blocked.test.ts", "plugins"],
  ])},
  ${JSON.stringify([
    [pluginExcluded, "first"],
    [pluginSibling, "second"],
  ])},
  ${JSON.stringify([
    [pluginExcluded, "override"],
    [pluginSibling, "override"],
  ])},
];
for (const [index, config] of configs.entries()) {
  const runner = await createVitest({ root, config: path.join(root, config), run: true, watch: false, reporters: [] });
  try {
    const actual = (await runner.globTestSpecifications()).map(spec =>
      [path.relative(root, spec.moduleId).split(path.sep).join("/"), spec.project.name]).sort();
    const expected = rows[index].filter(([file]) => !activeRemoved.includes(file)).sort();
    assert.deepEqual(actual, expected, config);
    if (index === 1) {
      assert.equal(runner.projects.length, 2);
      for (const project of runner.projects) {
        assert.equal(project.sharedViteServer, true);
        assert.equal(project.vite, runner.vite);
      }
    } else if (index === 0) {
      assert.equal(runner.projects.length, 3);
      assert.equal(new Set(runner.projects.map(project => project.vite)).size, 3);
      for (const project of runner.projects) {
        assert.equal(project.sharedViteServer, false);
        assert.notEqual(project.vite, runner.vite);
      }
    }
  } finally {
    await runner.close();
  }
}
if (!scope) {
  const adapter = ${JSON.stringify(path.join(repoRoot, "scripts/frv-test-exclusions.mjs"))};
  // Plugin and extension paths use separate validation scopes, just like FRV.
  for (const [scope, paths] of [["plugins", removed.slice(0, 2)], ["extensions", removed.slice(2)]]) {
    const result = spawnSync(process.execPath, [adapter, "run", "--", process.execPath, process.argv[1], scope], {
      cwd: root, encoding: "utf8", env: { ...process.env, FRV_TEST_EXCLUDE_SCOPE: scope,
        FRV_TEST_EXCLUDE_PATHS_JSON: JSON.stringify(paths), FRV_TEST_CONFIGS_JSON: JSON.stringify(configs) },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    configs.forEach((file, index) => assert.equal(fs.readFileSync(path.join(root, file), "utf8"), originals[index]));
  }
}
console.log("deferred exclusions and server ownership verified");
`,
    );
    const result = await runNodeScript(
      probe,
      {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_PATH: "",
        OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
      },
      DEFAULT_VITEST_TEST_TIMEOUT_MS,
      { cwd: root, requireProcessTreeExit: process.platform !== "win32" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("deferred exclusions and server ownership verified");
  });

  it("excludes exact files from native inline projects and restores candidate configs", async () => {
    const root = tempDirs.make("frv-test-exclusions-");
    const probe = path.join(root, "probe.mjs");
    fs.writeFileSync(
      probe,
      `import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateTestExclusions } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/frv-test-exclusions.mjs")).href)};

const root = ${JSON.stringify(root)};
const mode = process.argv[2];
const configs = ["test/vitest/vitest.plugins.config.ts", "test/vitest/vitest.extensions.config.ts"];
const excluded = ["src/plugins/first/retry.test.ts", "src/plugins/native-loader.test.ts", "extensions/example/retry.test.ts"];
const sibling = "src/plugins/second/retry.test.ts";
const outsideSelection = "src/plugins/not-selected.test.ts";
const extensionOutsideSelection = "extensions/unselected/retry.test.ts";
const common = { root, dir: path.join(root, "src/plugins"), include: ["**/*.test.ts"], exclude: ["not-selected.test.ts"] };
const project = (name, filters) => ({ extends: false, test: { ...common, name, ...filters } });
const plugins = { test: { ...common, projects: [
  project("plugins", { exclude: [...common.exclude, "native-loader.test.ts"] }),
  project("plugins-native-loader", { include: ["native-loader.test.ts"] }),
] } };
const extensions = { test: { root, dir: path.join(root, "extensions"), include: ["**/*.test.ts"], exclude: [] } };
const original = [
  '// Preserve candidate bytes, including CRLF.\\r\\nexport const nativeFiles = ' + JSON.stringify([excluded[1]]) + ';\\r\\nexport default ' + JSON.stringify(plugins) + ';\\r\\n',
  'import fs from "node:fs";\\nconst config = ' + JSON.stringify(extensions) + ';\\n' +
    'if (process.env.OPENCLAW_VITEST_INCLUDE_FILE) {\\n' +
    '  config.test.include = JSON.parse(fs.readFileSync(process.env.OPENCLAW_VITEST_INCLUDE_FILE, "utf8"))\\n' +
    '    .map(pattern => pattern.slice("extensions/".length));\\n}\\nexport default config;\\n',
].map(source => Buffer.from(source));
if (!mode) {
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write("package.json", '{"type":"module"}\\n');
  fs.symlinkSync(${JSON.stringify(fs.realpathSync(path.join(repoRoot, "node_modules")))}, path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const file of [...excluded, sibling, outsideSelection, extensionOutsideSelection]) write(file, "export {};\\n");
  configs.forEach((config, index) => write(config, original[index]));
}
const candidateRequire = createRequire(path.join(root, "package.json"));
const { createVitest } = await import(pathToFileURL(candidateRequire.resolve("vitest/node")).href);

async function discover(config) {
  const runner = await createVitest({
    root, config: path.join(root, config), watch: false, run: true, reporters: [],
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
if (mode) {
  if (mode === "unaffected") {
    assertRestored();
  } else if (mode === "extensions") {
    assert.deepEqual(await discover(configs[0]), pluginBaseline);
    assert.deepEqual(await discover(configs[1]), [extensionOutsideSelection]);
  } else {
    assert.deepEqual(fs.readFileSync(path.join(root, configs[1])), original[1]);
    assert.deepEqual(await discover(configs[0]), [sibling]);
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

for (const invalid of ["src/plugins/missing.test.ts", outsideSelection]) {
  await rejectsExclusion(invalid);
}
await rejectsExclusion(excluded[2], [configs[0]]);
assertRestored();

const adapter = ${JSON.stringify(path.join(repoRoot, "scripts/frv-test-exclusions.mjs"))};
const adapterEnv = (scope = "plugins", paths = excluded.slice(0, 2), selectedConfigs = configs) => ({
  ...process.env,
  FRV_TEST_EXCLUDE_SCOPE: scope,
  FRV_TEST_EXCLUDE_PATHS_JSON: JSON.stringify(paths),
  FRV_TEST_CONFIGS_JSON: JSON.stringify(selectedConfigs),
});
const commandEnv = adapterEnv();
const runAdapter = (args, env = commandEnv) => spawnSync(process.execPath, [adapter, "run", "--", ...args], {
  cwd: root, env, encoding: "utf8",
});
for (const [mode, scope, paths, selectedConfigs, expectedExit] of [
  ["unaffected", "plugins", excluded.slice(0, 2), [configs[1]], 0],
  ["plugins", "plugins", excluded.slice(0, 2), configs, 0],
  ["extensions", "extensions", [excluded[2]], configs, 0],
  ["failure", "plugins", excluded.slice(0, 2), configs, 23],
]) {
  const result = runAdapter([process.execPath, process.argv[1], mode], adapterEnv(scope, paths, selectedConfigs));
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
const conflicted = runAdapter([process.execPath, process.argv[1], "conflict"], adapterEnv("plugins", excluded.slice(0, 2), [secondConfig, ...configs]));
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
