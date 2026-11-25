import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyTestExclusions, parseTestExclusions } from "../../scripts/frv-test-exclusions.mjs";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { createDeferred, withinTest, withTestTimeout } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../vitest/vitest.timeouts.js";
import { assertFixtureProcessGroupStopped } from "./exited-descendant-reaper.test-support.js";

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

  it("retains deferred project invocation and its original failure", async () => {
    const failure = new Error("project construction failed");
    const env = { command: "serve", mode: "frozen-target", isPreview: false, isSsrBuild: false };
    let calls = 0;
    const config = applyTestExclusions(
      {
        test: {
          projects: [
            async (actual: typeof env) => {
              calls += 1;
              expect(actual).toBe(env);
              throw failure;
            },
            Promise.reject(failure),
          ],
        },
      },
      [],
      repoRoot,
      [],
    );
    expect(calls).toBe(0);
    const results = await Promise.allSettled([
      config.test.projects[0](env),
      config.test.projects[1],
    ]);
    expect(calls).toBe(1);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
  });

  it.skipIf(process.platform === "win32").for([false, true])(
    "retires command readers before restoration (escaped output: %s)",
    async (escaped, { signal }) => {
      // An intentionally unjoined command owns its private namespace until the
      // independently observed reader exits; the ordinary temp tracker cannot remove it.
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "frv-readers-"));
      const deadline = Date.now() + DEFAULT_VITEST_TEST_TIMEOUT_MS;
      const receipts = await openFixtureReceiptChannel();
      const cancel = new AbortController();
      let command: ReturnType<typeof runNodeScript> | undefined;
      const adapterExit = createDeferred<{ code: number | null; signal: string | null }>();
      const adapterClose = createDeferred<{ code: number | null; signal: string | null }>();
      let adapterStarted = false;
      let adapterPid: number | undefined;
      let expectedHandoffError: unknown;
      const pidFile = path.join(root, "reader.json");
      const leaderFile = path.join(root, "leader.pid");
      const readerExit = receipts.waitForExit("reader");
      void readerExit.catch(() => {});
      await runQaGatewayFixture(
        async () => {
          createVitestResourceOwner(root);
          const config = "test/vitest/vitest.plugins.config.ts";
          const configPath = path.join(root, config);
          const original = `export default { test: { root: ${JSON.stringify(root)}, dir: ${JSON.stringify(root)}, include: ["src/plugins/*.test.ts"], exclude: [] } };\n`;
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, original);
          fs.mkdirSync(path.join(root, "src/plugins"), { recursive: true });
          fs.writeFileSync(path.join(root, "src/plugins/reader.test.ts"), "export {};\n");
          fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
          fs.symlinkSync(
            fs.realpathSync(path.join(repoRoot, "node_modules")),
            path.join(root, "node_modules"),
            "dir",
          );

          // Execute exactly the trusted workflow's sparse tooling, so a full
          // checkout cannot conceal a missing eager lifecycle dependency.
          const workflow = fs.readFileSync(
            path.join(repoRoot, ".github/workflows/plugin-prerelease.yml"),
            "utf8",
          );
          const sparse = workflow
            .split("- &checkout_exclusion_tooling")[1]
            ?.match(/sparse-checkout: \|\n((?: +scripts\/[^\n]+\n)+)/u)?.[1];
          expect(sparse).toBeDefined();
          const tooling = path.join(root, ".frv-tooling");
          for (const file of sparse!
            .trim()
            .split("\n")
            .map((line) => line.trim())) {
            const destination = path.join(tooling, file);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(path.join(repoRoot, file), destination);
          }
          const reader = path.join(root, "reader.mjs");
          fs.writeFileSync(
            reader,
            `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
${fixtureReceiptClientSource(receipts.endpoint)}
fs.writeFileSync(${JSON.stringify(pidFile)} + ".tmp", JSON.stringify({ pid: process.pid, group: ${escaped ? "process.pid" : "process.ppid"} }));
fs.renameSync(${JSON.stringify(pidFile)} + ".tmp", ${JSON.stringify(pidFile)});
sendReceipt("reader", "ready");
await awaitRelease("reader", "admitted");
process.send("ready");
${
  escaped
    ? `await awaitRelease("reader", "inspect");
const config = ${JSON.stringify(configPath)};
assert.match(fs.readFileSync(config, "utf8"), /applyTestExclusions/);
const backups = fs.readdirSync(path.dirname(config)).filter(name => name.startsWith(".frv-source-"));
assert.equal(backups.length, 1);
assert.equal(fs.readFileSync(path.join(path.dirname(config), backups[0]), "utf8"), ${JSON.stringify(original)});
sendReceipt("reader", "retained bytes read");`
    : ""
}
await awaitRelease("reader", "exit");
process.exit(0);
`,
          );
          const leader = path.join(root, "leader.mjs");
          fs.writeFileSync(
            leader,
            `
import { spawn } from "node:child_process";
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid));
const reader = spawn(process.execPath, [${JSON.stringify(reader)}], {
  detached: ${escaped}, stdio: ["ignore", ${escaped ? '"inherit", "inherit"' : '"ignore", "ignore"'}, "ipc"],
});
reader.once("error", error => { console.error(error); process.exit(1); });
reader.once("message", () => process.exit(0));
`,
          );
          command = runNodeScript(
            [
              path.join(tooling, "scripts/frv-test-exclusions.mjs"),
              "run",
              "--",
              resolveTestNodeExecPath(),
              leader,
            ],
            {
              ...process.env,
              TMPDIR: root,
              TMP: root,
              TEMP: root,
              NODE_OPTIONS: "",
              NODE_PATH: "",
              OPENCLAW_VITEST_INCLUDE_FILE: "",
              FRV_TEST_EXCLUDE_SCOPE: "plugins",
              FRV_TEST_EXCLUDE_PATHS_JSON: JSON.stringify(["src/plugins/reader.test.ts"]),
              FRV_TEST_CONFIGS_JSON: JSON.stringify([config]),
            },
            DEFAULT_VITEST_TEST_TIMEOUT_MS,
            {
              cwd: root,
              signal: AbortSignal.any([signal, cancel.signal]),
              requireProcessTreeExit: true,
              onReady(child) {
                adapterStarted = true;
                adapterPid = child.pid;
                child.once("exit", (code, signal) => adapterExit.resolve({ code, signal }));
                child.once("close", (code, signal) => adapterClose.resolve({ code, signal }));
              },
            },
          );
          await withinTest(
            Promise.race([
              receipts.waitFor("reader", "ready"),
              command.then(() => {
                // The committed identity precedes the receipt; child completion
                // and side-channel delivery have no ordering guarantee.
                expect(fs.existsSync(pidFile)).toBe(true);
              }),
            ]),
            signal,
          );
          const identity = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
            pid: number;
            group: number;
          };
          expect(Number.isSafeInteger(identity.pid) && identity.pid > 1).toBe(true);
          expect(Number.isSafeInteger(identity.group) && identity.group > 1).toBe(true);
          receipts.release("reader", "admitted");
          const result = await withinTest(command, signal);
          expect(await withinTest(adapterExit.promise, signal)).toEqual({ code: 1, signal: null });
          expect(await withinTest(adapterClose.promise, signal)).toEqual({ code: 1, signal: null });
          expect(result.stderr).toContain("EPROCESSGROUP_CLEANUP_FAILED");
          const backups = fs
            .readdirSync(path.dirname(configPath))
            .filter((name) => name.startsWith(".frv-source-"));
          if (escaped) {
            // The wrapper preserves the inner owner's failed handoff even
            // though the real adapter has exited. Independent rescue is not release.
            expect(result.status).toBeNull();
            expect(result.error).toMatchObject({
              message: "Managed cleanup ownership handoff failed",
              code: "EPROCESSGROUP_CLEANUP_FAILED",
              processTreeState: "indeterminate",
            });
            expect(result.stderr).toContain("indeterminate");
            expect(result.stderr).toContain("overlays and backups retained");
            expect(result.stderr).toContain(configPath);
            expect(backups).toHaveLength(1);
            expect(result.stderr).toContain(path.join(path.dirname(configPath), backups[0]!));
            expect(() => process.kill(identity.pid, 0)).not.toThrow();
            receipts.release("reader", "inspect");
            await withinTest(receipts.waitFor("reader", "retained bytes read"), signal);
            expectedHandoffError = result.error;
          } else {
            expect(result.error).toBeUndefined();
            expect(result.status, result.stderr).toBe(1);
            await withinTest(readerExit, signal);
            assertFixtureProcessGroupStopped(identity.group);
            expect(result.stderr).toContain("terminated");
            expect(fs.readFileSync(configPath, "utf8")).toBe(original);
            expect(backups).toEqual([]);
          }
        },
        async () => {
          cancel.abort();
          try {
            let managedError: unknown;
            receipts.release("reader", "admitted");
            receipts.release("reader", "inspect");
            receipts.release("reader", "exit");
            if (command) {
              const joined = await withTestTimeout(
                command,
                Math.max(1, deadline - Date.now()),
                "FRV adapter did not join",
              );
              managedError = joined.error;
            }
            if (adapterStarted) {
              await withTestTimeout(
                adapterClose.promise,
                Math.max(1, deadline - Date.now()),
                "FRV adapter did not close",
              );
              expect(adapterPid).toBeDefined();
              assertFixtureProcessGroupStopped(adapterPid!);
            }
            if (fs.existsSync(pidFile)) {
              await withTestTimeout(
                readerExit,
                Math.max(1, deadline - Date.now()),
                "FRV reader did not exit",
              );
              const identity = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { group: number };
              assertFixtureProcessGroupStopped(identity.group);
            } else if (fs.existsSync(leaderFile)) {
              throw new Error("FRV reader identity was not published");
            }
            if (fs.existsSync(leaderFile)) {
              assertFixtureProcessGroupStopped(Number(fs.readFileSync(leaderFile, "utf8")));
            }
            // Only the asserted intentional handoff failure has this independent
            // physical rescue. Unknown managed failures still retain the namespace.
            if (managedError !== undefined && managedError !== expectedHandoffError) {
              throw managedError;
            }
            await receipts.close();
            fs.rmSync(root, { recursive: true, force: true });
          } catch (cause) {
            await receipts.close();
            throw new Error(`FRV fixture retained at ${root}: reader cleanup was not verified`, {
              cause,
            });
          }
        },
      );
    },
  );

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
import { setImmediate } from "node:timers/promises";
import { applyTestExclusions, validateTestExclusions } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/frv-test-exclusions.mjs")).href)};

const root = ${JSON.stringify(root)};
const mode = process.argv[2];
const configs = ["test/vitest/vitest.plugins.config.ts", "test/vitest/vitest.extensions.config.ts"];
const excluded = ["src/plugins/first/retry.test.ts", "src/plugins/native-loader.test.ts", "extensions/example/retry.test.ts"];
const sibling = "src/plugins/second/retry.test.ts";
const outsideSelection = "src/plugins/not-selected.test.ts";
const extensionOutsideSelection = "extensions/unselected/retry.test.ts";
const common = { root, dir: path.join(root, "src/plugins"), include: ["**/*.test.ts"], exclude: ["not-selected.test.ts"] };
const project = (name, filters) => ({ test: { dir: common.dir, include: common.include, exclude: common.exclude, name, ...filters } });
const plugins = { test: { ...common, include: [], sharedViteServer: true, projects: [
  project("plugins", { exclude: [...common.exclude, "native-loader.test.ts"] }),
  project("plugins-native-loader", { include: ["native-loader.test.ts"] }),
  project("plugins-empty", { include: [] }),
] } };
const extensions = { test: { root, dir: path.join(root, "extensions"), include: ["**/*.test.ts"], exclude: [] } };
const original = [
  '// Preserve candidate bytes, including CRLF.\\r\\nimport assert from "node:assert/strict";\\r\\n' +
    'export const nativeFiles = ' + JSON.stringify([excluded[1]]) + ';\\r\\n' +
    'const config = ' + JSON.stringify(plugins) + ';\\r\\n' +
    'const [plugin, nativeLoader, plain] = config.test.projects;\\r\\n' +
    'plain.plugins = [false, [null, false]];\\r\\n' +
    'plugin.plugins = [{ name: "late-exclude-owner", config: { order: "post", handler(value) {\\r\\n' +
    '  value.test.exclude = ["not-selected.test.ts", "native-loader.test.ts"];\\r\\n' +
    '} } }];\\r\\n' +
    'let calls = 0;\\r\\nconfig.test.projects = [Promise.resolve(plugin), async (env) => {\\r\\n' +
    '  assert.equal(++calls, 1);\\r\\n' +
    '  assert.deepEqual(env, { command: "serve", mode: "test", isPreview: false, isSsrBuild: false });\\r\\n' +
    '  return nativeLoader;\\r\\n}, plain];\\r\\nexport default config;\\r\\n',
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
const { createVitest, resolveConfig } = await import(pathToFileURL(candidateRequire.resolve("vitest/node")).href);

if (!mode) {
  const failure = new Error("later project failed while the first factory was pending");
  let rejectLater;
  const laterProject = new Promise((_resolve, reject) => { rejectLater = reject; });
  // Observe the input itself; the overlay owns observing its new mapped promise.
  void laterProject.catch(() => {});
  let factoryCalls = 0;
  let factoryFinished = false;
  const config = applyTestExclusions({ test: { root, projects: [
    async () => {
      factoryCalls++;
      rejectLater(failure);
      await setImmediate();
      factoryFinished = true;
      return { test: { name: "delayed-first", include: [] } };
    },
    laterProject,
  ] } }, [], root, []);
  assert.equal(factoryCalls, 0);
  await assert.rejects(resolveConfig({ config: false }, config), error => error === failure);
  assert.equal(factoryCalls, 1);
  assert.equal(factoryFinished, true);
}

async function discover(config) {
  const runner = await createVitest({
    root, config: path.join(root, config), watch: false, run: true, reporters: [],
  });
  try {
    if (config === configs[0]) {
      assert.equal(runner.projects.length, 3);
      for (const project of runner.projects) {
        const shared = project.name !== "plugins";
        assert.equal(project.sharedViteServer, shared);
        assert.equal(project.vite === runner.vite, shared);
      }
    }
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
