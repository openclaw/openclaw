import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeEvalArgs } from "../src/test-utils/node-process.ts";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { loadVitestPerformanceConfig } from "./vitest/vitest.performance-config.ts";

const generationHelpers = `
const generation = path.join(root, "dependency-generation.txt");
const transitionLock = version => {
  fs.writeFileSync(path.join(root, "bun.lock"), JSON.stringify({ version }));
  fs.writeFileSync(generation, version);
};
const versionPlugin = (name, directory, subjects) => ({
  name,
  transform(code, id) {
    const subject = Object.keys(subjects).find(file => id === path.join(directory, file).replaceAll("\\\\", "/"));
    if (!subject) return;
    const version = fs.readFileSync(generation, "utf8");
    if (subjects[subject]) fs.appendFileSync(path.join(directory, subjects[subject]), version + "\\n");
    return { code: code.replace("__DEPENDENCY_VERSION__", version), map: null };
  },
});
`;

describe("filesystem module cache ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const filesAt = (root: string) => ({
    write: (file: string, contents: string) => fs.writeFileSync(path.join(root, file), contents),
    read: (file: string) => fs.readFileSync(path.join(root, file), "utf8"),
    append: (file: string, contents: string) => fs.appendFileSync(path.join(root, file), contents),
  });
  const cli = path.join(
    path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const runNode = (
    root: string,
    checkout: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
    expectedStatus = 0,
  ) => {
    const result = spawnSync(process.execPath, args, {
      cwd: checkout,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        CI: "1",
        HOME: root,
        ...env,
      },
      timeout: 15_000,
    });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(
      expectedStatus,
    );
    return result;
  };
  const vitestArgs = (checkout: string, args: string[] = []) => [
    cli,
    "run",
    "--config",
    path.join(checkout, "vitest.config.mjs"),
    ...args,
  ];
  const prepareCacheFixture = (name: string) => {
    const root = fs.realpathSync(tempDirs.make(`oc-vitest-cache-${name}-`));
    const files = filesAt(root);
    fs.mkdirSync(path.join(root, "node_modules"));
    files.write(
      "package.json",
      JSON.stringify({ name: `cache-${name}`, type: "module", workspaces: [] }),
    );
    const generation = path.join(root, "dependency-generation.txt");
    const transitionLock = (version: string) => {
      // bun.lock is only a recognized hash input; no package manager is invoked.
      files.write("bun.lock", JSON.stringify({ version }));
      fs.writeFileSync(generation, version);
    };
    transitionLock("1.0.0");
    return { root, generation, transitionLock, ...files };
  };
  const runCacheApi = (root: string, source: string) =>
    runNode(
      root,
      root,
      createNodeEvalArgs(`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createVitest } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("vitest/node")).href)};
const root = ${JSON.stringify(root)};
const cacheConfig = ${JSON.stringify(loadVitestPerformanceConfig({}, "linux", root))};
const create = (options = {}, overrides = {}) => createVitest("test", {
  root, config: false, watch: false, ...cacheConfig, ...options,
}, overrides);
const withContext = async (options, overrides, run) => {
  const ctx = await create(options, overrides);
  try { await run(ctx); } finally { await ctx.close(); }
};
${source}
`),
    );

  it("preserves each project's optimized dependency identity when reusing shared transforms", () => {
    const { root } = prepareCacheFixture("optimizer-identity");
    const cacheOwner = new URL("./vitest/vitest.performance-config.ts", import.meta.url).href;
    runCacheApi(
      root,
      `
import { createVitestProjectCachePlugin } from ${JSON.stringify(cacheOwner)};
fs.writeFileSync(path.join(root, "subject.js"), 'export const dependencyRoot = "__OPTIMIZER_ROOT__";');
const transforms = [];
const plugin = {
  name: "fixture-optimized-dependency-import",
  transform(code, id) {
    if (!id.endsWith("/subject.js")) return;
    const directory = this.environment.config.cacheDir;
    transforms.push(directory);
    return { code: code.replace('"__OPTIMIZER_ROOT__"', JSON.stringify(directory)), map: null };
  },
};
const options = {
  projects: ["A", "B"].map(name => ({
    extends: false,
    root,
    plugins: [plugin, createVitestProjectCachePlugin()],
    test: { name, ...cacheConfig },
  })),
};
for (let pass = 0; pass < 2; pass++) {
  await withContext(options, {}, async ctx => {
    const directories = [];
    for (const name of ["A", "B"]) {
      const project = ctx.getProjectByName(name);
      const { dependencyRoot } = await project.import("./subject.js");
      assert.equal(dependencyRoot, project.vite.config.cacheDir, name + " must keep its own dependency imports");
      directories.push(dependencyRoot);
    }
    assert.notEqual(directories[0], directories[1]);
  });
}
assert.equal(transforms.length, 2, "both projects must reuse their own persisted transforms on the second run");
`,
    );
  });

  it.each(["bundle", "runner"] as const)(
    "invalidates declaring configs without discarding unrelated project transforms (%s)",
    (configLoader) => {
      const { root } = prepareCacheFixture(`declaring-${configLoader}`);
      const cacheOwner = new URL("./vitest/vitest.performance-config.ts", import.meta.url).href;
      runCacheApi(
        root,
        `
const owner = ${JSON.stringify(cacheOwner)};
const shared = path.join(root, "shared.mjs");
fs.writeFileSync(path.join(root, "subject.js"), 'export const value = "__OPTION__";');
fs.writeFileSync(shared, \`
import fs from 'node:fs';
import path from 'node:path';
import { createVitestProjectCachePlugin } from \${JSON.stringify(owner)};
const suffix = '-shared-first';
export function project(name, option, declaringConfigFile) {
  return {
    extends: false,
    root: \${JSON.stringify(root)},
    cacheDir: path.join(\${JSON.stringify(root)}, 'optimizer-' + name),
    plugins: [createVitestProjectCachePlugin(declaringConfigFile), {
      name: 'fixture-same-name-plugin-options',
      transform(code, id) {
        if (!id.endsWith('/subject.js')) return;
        fs.appendFileSync(path.join(\${JSON.stringify(root)}, name + '-transforms.txt'), 'transform\\\\n');
        return { code: code.replace('__OPTION__', option + suffix), map: null };
      },
    }],
    test: { name, ...\${JSON.stringify(cacheConfig)} },
  };
}
\`);
for (const [name, option] of [['unit', 'unit'], ['e2e', 'first']]) {
  fs.writeFileSync(path.join(root, name + '.config.mjs'), \`
import { fileURLToPath } from 'node:url';
import { project } from './shared.mjs';
const option = \${JSON.stringify(option)};
export default {root: \${JSON.stringify(root)}, test: {
  ...\${JSON.stringify(cacheConfig)},
  projects: [project(\${JSON.stringify(name)}, option, fileURLToPath(import.meta.url))],
}};
\`);
}
fs.writeFileSync(path.join(root, 'wrapper.config.mjs'), "export { default } from './e2e.config.mjs';");
const counts = () => ['unit', 'e2e'].map(name => {
  const file = path.join(root, name + '-transforms.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n').length : 0;
});
const check = async (config, name, expected) => {
  await withContext({config: path.join(root, config + '.config.mjs'), configLoader: ${JSON.stringify(configLoader)}}, {}, async ctx => {
    const {value} = await ctx.getProjectByName(name).import('./subject.js');
    assert.equal(value, expected, name + ' must use current declaring-file plugin options');
  });
};
await check('unit', 'unit', 'unit-shared-first');
await check('e2e', 'e2e', 'first-shared-first');
await check('wrapper', 'e2e', 'first-shared-first');
const firstWrapperCounts = counts();
await check('wrapper', 'e2e', 'first-shared-first');
assert.deepEqual(counts(), firstWrapperCounts, 'unchanged wrapper must reuse transforms');
const e2e = path.join(root, 'e2e.config.mjs');
fs.writeFileSync(e2e, fs.readFileSync(e2e, 'utf8').replace('"first"', '"second"'));
await check('unit', 'unit', 'unit-shared-first');
await check('wrapper', 'e2e', 'second-shared-first');
await check('e2e', 'e2e', 'second-shared-first');
assert.deepEqual(counts(), [1, 4], 'E2E-only changes must retain unrelated unit transforms');
fs.writeFileSync(shared, fs.readFileSync(shared, 'utf8').replace('-shared-first', '-shared-second'));
await check('unit', 'unit', 'unit-shared-second');
await check('wrapper', 'e2e', 'second-shared-second');
await check('e2e', 'e2e', 'second-shared-second');
assert.deepEqual(counts(), [2, 6], 'shared plugin changes must invalidate both projects');
`,
      );
    },
  );

  it("preserves another checkout's cache when shared dependencies change", () => {
    const root = tempDirs.make("oc-vitest-cache-ownership-");
    const sharedModules = path.join(root, "shared", "node_modules");
    fs.mkdirSync(path.join(sharedModules, ".pnpm"), { recursive: true });
    const lockfile = path.join(sharedModules, ".pnpm", "lock.yaml");
    fs.writeFileSync(lockfile, "lockfileVersion: 1\n");
    const prepareCheckout = (name: string) => {
      const checkout = path.join(root, name);
      const { write } = filesAt(checkout);
      fs.mkdirSync(checkout);
      // Stop Vite's workspace search before it reaches this repository. The
      // symlink points only at this fixture's dependencies and writable cache.
      write("package.json", JSON.stringify({ name, type: "module", workspaces: [] }));
      fs.symlinkSync(sharedModules, path.join(checkout, "node_modules"), "junction");
      write("fixture.test.js", 'test("runs the fixture", () => expect(2 + 2).toBe(4));\n');
      const cacheConfig = loadVitestPerformanceConfig({}, "linux", checkout);
      const config = {
        root: checkout,
        test: {
          globals: true,
          include: ["fixture.test.js"],
          maxWorkers: 1,
          ...cacheConfig,
        },
      };
      write("vitest.config.mjs", `export default ${JSON.stringify(config)};\n`);
      return { checkout, cacheConfig };
    };
    const first = prepareCheckout("first");
    const second = prepareCheckout("second");
    runNode(root, first.checkout, vitestArgs(first.checkout));
    const firstCache = first.cacheConfig.fsModuleCachePath!;
    const sentinel = path.join(firstCache, "first-checkout-sentinel");
    fs.writeFileSync(sentinel, "owned by first checkout");
    fs.writeFileSync(lockfile, "lockfileVersion: 2\n");
    runNode(root, second.checkout, vitestArgs(second.checkout));
    expect(fs.readFileSync(sentinel, "utf8")).toBe("owned by first checkout");
  });

  it("reuses shared project transforms after a lock transition without serving a stale later project", () => {
    const { root, generation, transitionLock, write, read, append } =
      prepareCacheFixture("projects");
    // Reporter imports precede test execution and must observe the same dependency
    // generation as the selected projects after a lock transition.
    const reporterEvents = path.join(root, "reporter-events.txt");
    const versionSource = 'export const version = "__DEPENDENCY_VERSION__";\n';
    write("reporter-subject.js", versionSource);
    write(
      "reporter.js",
      `import { appendFileSync } from "node:fs";
import { version } from "./reporter-subject.js";
export default class {
  onInit() {
    appendFileSync(${JSON.stringify(reporterEvents)}, version + "\\n");
  }
}
`,
    );
    for (const name of ["A", "B"]) {
      const project = path.join(root, name);
      const projectFiles = filesAt(project);
      fs.mkdirSync(project);
      projectFiles.write("transforms.txt", "");
      for (const file of ["subject.js", "configured-subject.js", "body-subject.js"]) {
        projectFiles.write(file, versionSource);
      }
      projectFiles.write(
        "fixture.test.js",
        `import { appendFileSync, readFileSync } from "node:fs";
import { version } from "fixture-subject";
const events = ${JSON.stringify(path.join(project, "events.txt"))};
appendFileSync(events, "collect:" + version + "\\n");
beforeAll(() => appendFileSync(events, "beforeAll\\n"));
test("executes the current dependency generation", async () => {
  appendFileSync(events, "body\\n");
  expect(version).toBe(readFileSync(${JSON.stringify(generation)}, "utf8"));
  const { version: bodyVersion } = await import("./body-subject.js");
  expect(bodyVersion).toBe(readFileSync(${JSON.stringify(generation)}, "utf8"));
});
`,
      );
    }
    const shardOwner = new URL("./vitest/vitest.project-shard-config.ts", import.meta.url).href;
    const scopedOwner = new URL("./vitest/vitest.scoped-config.ts", import.meta.url).href;
    write(
      "vitest.config.mjs",
      `import fs from "node:fs";
import path from "node:path";
import { createProjectShardVitestConfig } from ${JSON.stringify(shardOwner)};
import { createScopedVitestConfig } from ${JSON.stringify(scopedOwner)};
const root = ${JSON.stringify(root)};
${generationHelpers}
const aggregate = createProjectShardVitestConfig([]);
const scoped = createScopedVitestConfig([], { env: {}, argv: [] });
const subjectFile = "subject.js";
export default {
  root,
  plugins: [versionPlugin("fixture-reporter-plugin", root, { "reporter-subject.js": "reporter-transforms.txt" })],
  test: {
    reporters: ["default", path.join(root, "reporter.js")],
    fsModuleCache: aggregate.test.fsModuleCache,
    fsModuleCachePath: aggregate.test.fsModuleCachePath,
    projects: ["A", "B"].map((name) => ({
      extends: false,
      root: path.join(root, name),
      resolve: { alias: { "fixture-subject": path.join(root, name, subjectFile) } },
      // The generation file is outside the source graph; its paired lock change must invalidate transforms.
      plugins: [versionPlugin("fixture-external-plugin", path.join(root, name), {
        [subjectFile]: "transforms.txt", "body-subject.js": "body-transforms.txt",
      })],
      test: {
        name,
        globals: true,
        include: ["fixture.test.js"],
        fsModuleCache: scoped.test.fsModuleCache,
        fsModuleCachePath: scoped.test.fsModuleCachePath,
      },
    })),
  },
};
`,
    );
    const cacheConfig = loadVitestPerformanceConfig({}, "linux", root);
    const env = {
      OPENCLAW_VITEST_FS_MODULE_CACHE: "1",
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: cacheConfig.fsModuleCachePath,
    };
    const reporterGenerations: string[] = [];
    const check = (projects: string[], expected: [number, number, number], args: string[] = []) => {
      const selectedArgs = projects.flatMap((name) => ["--project", name]);
      runNode(root, root, vitestArgs(root, [...selectedArgs, ...args]), env);
      reporterGenerations.push(fs.readFileSync(generation, "utf8"));
      expect(read("reporter-events.txt").trimEnd().split("\n")).toEqual(reporterGenerations);
      const counts = ["A/transforms.txt", "B/transforms.txt", "reporter-transforms.txt"].map(
        (file) => read(file).split("\n").length - 1,
      );
      expect(counts, `subject transforms after selecting ${projects.join("+")}`).toEqual(expected);
    };
    check(["A", "B"], [1, 1, 1], ["--testNamePattern=(?!)"]);
    for (const name of ["A", "B"]) {
      expect(read(`${name}/events.txt`)).toBe("collect:1.0.0\n");
      expect(fs.existsSync(path.join(root, name, "body-transforms.txt"))).toBe(false);
    }
    check(["A", "B"], [1, 1, 1]);
    for (const name of ["A", "B"]) {
      expect(read(`${name}/events.txt`)).toBe("collect:1.0.0\ncollect:1.0.0\nbeforeAll\nbody\n");
      expect(read(`${name}/body-transforms.txt`)).toBe("1.0.0\n");
    }
    transitionLock("2.0.0");
    check(["A"], [2, 1, 2]);
    check(["A"], [2, 1, 2]);
    check(["B"], [2, 2, 2]);
    check(["B"], [2, 2, 2]);

    // Reuse must still respect ordinary source and config invalidation.
    append("A/subject.js", "\n// source edit\n");
    check(["A", "B"], [3, 2, 2]);
    write(
      "vitest.config.mjs",
      read("vitest.config.mjs").replace(
        'const subjectFile = "subject.js";',
        'const subjectFile = "configured-subject.js";',
      ),
    );
    check(["A", "B"], [4, 3, 3]);
    check(["A", "B"], [4, 3, 3]);

    append("A/configured-subject.js", '\nthrow new Error("fixture collection import failure");\n');
    const failedArgs = vitestArgs(root, ["--project", "A", "--testNamePattern=(?!)"]);
    const failedCollection = runNode(root, root, failedArgs, env, 1);
    expect(`${failedCollection.stdout}\n${failedCollection.stderr}`).toContain(
      "fixture collection import failure",
    );
  });

  it("imports the current lock generation through awaited configureVitest hooks", () => {
    const { root } = prepareCacheFixture("hook-imports");
    runCacheApi(
      root,
      `
${generationHelpers}
const names = ["project-subject.js", "vitest-subject.js", "post-init.js"];
for (const name of names) {
  fs.writeFileSync(path.join(root, name), 'export const version = "__DEPENDENCY_VERSION__";');
}
let importInHook = false;
let hookValues;
const keyed = new Set();
const plugin = {
  ...versionPlugin("fixture-hook-imports", root, Object.fromEntries(names.map(name => [name, null]))),
  async configureVitest({ project, vitest, defineCacheKeyGenerator }) {
    defineCacheKeyGenerator(({ id }) => {
      keyed.add(id);
      return "fixture-hook-imports";
    });
    if (importInHook) {
      const first = await project.import("./project-subject.js");
      const second = await vitest.import("./vitest-subject.js");
      hookValues = [first.version, second.version];
    }
  },
};
await withContext({}, { plugins: [plugin] }, async ctx => {
  assert.equal((await ctx.getRootProject().import("./project-subject.js")).version, "1.0.0");
  assert.equal((await ctx.import("./vitest-subject.js")).version, "1.0.0");
  assert.ok(fs.readdirSync(cacheConfig.fsModuleCachePath).length > 1);
});
transitionLock("2.0.0");
importInHook = true;
await withContext({}, { plugins: [plugin] }, async ctx => {
  assert.deepEqual(hookValues, ["2.0.0", "2.0.0"], "configureVitest imports must use the current generation");
  assert.equal((await ctx.import("./post-init.js")).version, "2.0.0");
  assert.ok(keyed.has(path.join(root, "post-init.js").replaceAll("\\\\", "/")));
});
`,
    );
  });

  it("imports an unseen module after an awaited idle cache clear", () => {
    const { root } = prepareCacheFixture("idle-clear");
    runCacheApi(
      root,
      `
${generationHelpers}
fs.writeFileSync(path.join(root, "first.js"), "export const value = 1;");
fs.writeFileSync(path.join(root, "next.js"), 'export const value = 2; export const version = "__DEPENDENCY_VERSION__";');
const overrides = {
  plugins: [versionPlugin("fixture-clear-generation", root, { "next.js": null })],
};
await withContext({}, overrides, async ctx => {
  assert.equal((await ctx.import("./first.js")).value, 1);
  assert.ok(fs.readdirSync(cacheConfig.fsModuleCachePath).length > 1);
  await ctx.waitForTestRunEnd();
  await ctx.clearCache();
  assert.equal(fs.existsSync(cacheConfig.fsModuleCachePath), false);
  const next = await ctx.import("./next.js");
  assert.equal(next.value, 2);
  assert.equal(next.version, "1.0.0");
  assert.ok(fs.readdirSync(cacheConfig.fsModuleCachePath).length > 0);
});
transitionLock("2.0.0");
await withContext({}, overrides, async ctx => {
  const current = await ctx.import("./next.js");
  assert.equal(current.value, 2);
  assert.equal(current.version, "2.0.0", "post-clear entries must use the current generation after restart");
});
`,
    );
  });
});
