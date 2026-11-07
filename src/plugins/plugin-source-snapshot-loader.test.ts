import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";
import { createPluginSharedSnapshotModuleLoader } from "./plugin-source-snapshot-loader.js";

const cold = createPluginModuleGenerationTestHarness();
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

it.each([false, true])(
  "matches linked CommonJS ancestry and identity with preserve-symlinks=%s",
  async (preserve) => {
    const f = fixture(
      {
        "entry.cjs":
          "const a=require('a'), b=require('a2'); module.exports={...a,same:a===b,resolved:require.resolve('a'),esm:()=>import('a/esm.mjs')};",
        "packages/a/package.json": '{"main":"index.cjs"}',
        "packages/a/index.cjs":
          "module.exports={value:require('b'),relative:require('../shared.cjs'),filename:__filename,dirname:__dirname,asset:require('node:fs').readFileSync(require('node:path').join(__dirname,'..','asset.txt'),'utf8')};",
        "packages/a/esm.mjs":
          "import {readFileSync} from 'node:fs';export const location=import.meta.url;export const asset=readFileSync(new URL('../asset.txt',import.meta.url),'utf8');",
        "packages/asset.txt": "physical-asset",
        "node_modules/asset.txt": "logical-asset",
        "packages/shared.cjs": "module.exports='physical-relative';",
        "node_modules/shared.cjs": "module.exports='logical-relative';",
        "packages/node_modules/b/package.json": '{"main":"index.cjs"}',
        "packages/node_modules/b/index.cjs": "module.exports='physical';",
        "node_modules/b/package.json": '{"main":"index.cjs"}',
        "node_modules/b/index.cjs": "module.exports='logical';",
      },
      { "node_modules/a": "packages/a", "node_modules/a2": "packages/a" },
    );
    const argv = process.execArgv;
    const flags = preserve ? ["--preserve-symlinks"] : [];
    const coldResult = spawnSync(
      process.execPath,
      [
        ...flags,
        "-e",
        "const v=require(process.argv[1]);v.esm().then(esm=>console.log(JSON.stringify({...v,esm}))).catch(e=>{console.error(e);process.exitCode=1});",
        path.join(f.root, "entry.cjs"),
      ],
      { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
    );
    expect(coldResult.status, coldResult.stderr).toBe(0);
    const expected: unknown = JSON.parse(coldResult.stdout);
    try {
      process.execArgv = flags;
      const actual = f.loader().requireModule(path.join(f.root, "entry.cjs")) as Record<
        string,
        unknown
      > & { esm(): Promise<Record<string, unknown>> };
      expect({ ...actual, esm: { ...(await actual.esm()) } }).toEqual(expected);
    } finally {
      process.execArgv = argv;
    }
  },
);

function fixture(files: Record<string, string>, links: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-byte-loader-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = new Map<string, { kind: "file" | "directory" | "link" }>();
  const sourceLinks = new Map<string, string>();
  const expected = new Map<string, string>();
  const resolution = new Map<string, string>();
  const reads: string[] = [];
  for (const [relative, contents] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    entries.set(filename, { kind: "file" });
    expected.set(filename, contents);
    if (path.basename(filename) === "package.json") {
      resolution.set(path.dirname(filename), contents);
    }
    for (
      let parent = path.dirname(filename);
      parent.startsWith(root);
      parent = path.dirname(parent)
    ) {
      entries.set(parent, { kind: "directory" });
      if (parent === root) {
        break;
      }
    }
  }
  const configuration = new Map<string, string>();
  for (const [relative, text] of Object.entries(files)) {
    if (relative.endsWith(".json")) {
      configuration.set(path.join(root, relative), text);
    }
  }
  for (const [relative, target] of Object.entries(links)) {
    const filename = path.join(root, relative);
    const destination = path.join(root, target);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.symlinkSync(destination, filename, "junction");
    entries.set(filename, { kind: "link" });
    sourceLinks.set(filename, destination);
  }
  const canonical = (filename: string) => {
    for (const [link, target] of sourceLinks) {
      if (filename === link || filename.startsWith(link + path.sep)) {
        return path.join(target, path.relative(link, filename));
      }
    }
    return filename;
  };
  const snapshot = {
    rootDir: root,
    payloadRoot: root,
    sourceAliases: {},
    sourceLinks,
    entries,
    resolution,
    configuration,
    assertCurrent() {},
    assertMemberPath(filename: string) {
      if (!expected.has(canonical(filename))) {
        throw new Error(`Unowned module ${filename}`);
      }
    },
    readVerifiedFile(filename: string) {
      reads.push(path.relative(root, filename));
      const contents = fs.readFileSync(filename);
      if (contents.toString("utf8") !== expected.get(canonical(filename))) {
        throw new Error(`Corrupt module ${filename}`);
      }
      return contents;
    },
  };
  const loader = (
    options: Partial<Parameters<typeof createPluginSharedSnapshotModuleLoader>[0]> = {},
  ) => {
    const value = createPluginSharedSnapshotModuleLoader({
      snapshot,
      loadNativeModule() {
        throw new Error("unexpected native module");
      },
      ...options,
    });
    cleanups.push(value.dispose);
    return value;
  };
  return { root, loader, reads };
}

describe("shared snapshot verified module evaluation", () => {
  it("retains real asset paths and gives each instance its own CJS and ESM evaluations", async () => {
    const f = fixture({
      "package.json": '{"type":"module"}',
      "counter.cjs":
        "let count=0; exports.next=()=>++count; exports.path=__filename; exports.asset=()=>require('node:fs').readFileSync(require('node:path').join(__dirname,'asset.txt'),'utf8');",
      "entry.mjs":
        "import counter from './counter.cjs'; export {counter}; let count=0; export const next=()=>++count; export const location=import.meta.url;",
      "asset.txt": "real asset",
      "unused.mjs": "throw new Error('unused');",
    });
    const a = (await f.loader().importModule(path.join(f.root, "entry.mjs"))) as {
      next(): number;
      counter: { next(): number; path: string; asset(): string };
      location: string;
    };
    const b = (await f.loader().importModule(path.join(f.root, "entry.mjs"))) as typeof a;
    expect([a.next(), a.next(), b.next()]).toEqual([1, 2, 1]);
    expect([a.counter.next(), a.counter.next(), b.counter.next()]).toEqual([1, 2, 1]);
    expect(a.counter.asset()).toBe("real asset");
    expect(a.counter.path).toBe(path.join(f.root, "counter.cjs"));
    expect(a.location).toBe(pathToFileURL(path.join(f.root, "entry.mjs")).href);
    expect(f.reads).toEqual(["entry.mjs", "counter.cjs", "entry.mjs", "counter.cjs"]);
  });

  it("verifies lazily loaded bytes and restricts dynamic and reanchored module operations", async () => {
    const f = fixture({
      "entry.cjs":
        "exports.load=name=>require(name); exports.anchored=(anchor,name)=>require('node:module').Module.createRequire(anchor)(name); exports.dynamic=name=>import(name);",
      "later.cjs": "module.exports=41;",
    });
    const value = f.loader().requireModule(path.join(f.root, "entry.cjs")) as {
      load(name: string): unknown;
      anchored(anchor: string, name: string): unknown;
      dynamic(name: string): Promise<unknown>;
    };
    expect(f.reads).toEqual(["entry.cjs"]);
    expect(() => value.load("./outside.cjs")).toThrow(
      expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }),
    );
    expect(() => value.anchored(path.join(os.tmpdir(), "outside.cjs"), "./outside.cjs")).toThrow(
      expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }),
    );
    await expect(value.dynamic("./outside.cjs")).rejects.toMatchObject({
      code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY",
    });
    fs.writeFileSync(path.join(f.root, "later.cjs"), "module.exports=99;");
    expect(() => value.load("./later.cjs")).toThrow(
      `Corrupt module ${path.join(f.root, "later.cjs")}`,
    );
  });

  it("uses the same per-instance builtin facade from ESM and CJS", async () => {
    const f = fixture({
      "entry.mjs":
        "import workers,{Worker} from 'node:worker_threads'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); export const same=Worker===workers.Worker&&Worker===require('worker_threads').Worker; export {Worker};",
    });
    const worker = function Worker() {};
    const facade = { ...(await import("node:worker_threads")), Worker: worker };
    const value = (await f
      .loader({
        loadBuiltin: (name) =>
          name.replace(/^node:/, "") === "worker_threads" ? facade : undefined,
      })
      .importModule(path.join(f.root, "entry.mjs"))) as { same: boolean; Worker: unknown };
    expect(value.same).toBe(true);
    expect(value.Worker).toBe(worker);
  });

  it("compiles verified TypeScript in memory through the existing compiler", async () => {
    const f = fixture({
      "entry.ts":
        "import {value} from './value.ts'; const answer:number=value+1; export default {answer};",
      "value.ts": "export const value:number=41;",
    });
    const value = (await f.loader().importModule(path.join(f.root, "entry.ts"))) as {
      default: { answer: number };
    };
    expect(value.default.answer).toBe(42);
    expect(fs.readdirSync(f.root).toSorted()).toEqual(["entry.ts", "value.ts"]);
    expect(new Set(f.reads)).toEqual(new Set(["entry.ts", "value.ts"]));
  });

  it("evaluates parent-provided child source with a synthetic anchor and main identity", async () => {
    const f = fixture({ "dependency.cjs": "module.exports=7;" });
    const loader = f.loader({ main: true });
    const value = loader.evaluateSource(
      "module.exports={main:require.main===module,id:module.id,value:require('./dependency.cjs')};",
      { filename: path.join(f.root, "[worker eval]"), format: "commonjs" },
    ) as { main: boolean; id: string; value: number };
    expect(value).toEqual({ main: true, id: ".", value: 7 });
    const module = (await loader.evaluateSource("export const main=import.meta.main;", {
      filename: path.join(f.root, "[module eval]"),
      format: "module",
    })) as { main: boolean };
    expect(module.main).toBe(true);
  });
});

it("honors configured TypeScript paths using sealed configuration", () => {
  vi.stubEnv("JITI_TSCONFIG_PATHS", "true");
  const subject = fixture({
    "package.json": '{"type":"commonjs"}',
    "tsconfig.json": '{"extends":"./base.json"}',
    "base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@local/value":["value.cjs"]}}}',
    "index.cjs": 'module.exports = require("@local/value");',
    "value.cjs": 'module.exports = "from sealed paths";',
  });
  expect(subject.loader().requireModule(path.join(subject.root, "index.cjs"))).toBe(
    "from sealed paths",
  );
});

it("honors ordered require.resolve paths without leaving sealed membership", () => {
  const f = fixture({
    "entry.cjs": "module.exports=(request,paths)=>require.resolve(request,{paths});",
    "node_modules/dep/index.js": "module.exports='root';",
    "alternate/node_modules/dep/index.js": "module.exports='alternate';",
    "alternate/value.cjs": "module.exports=42;",
  });
  const resolve = f.loader().requireModule(path.join(f.root, "entry.cjs")) as (
    request: string,
    paths: string[],
  ) => string;
  const alternate = path.join(f.root, "alternate");
  expect(resolve("dep", [alternate])).toBe(path.join(alternate, "node_modules/dep/index.js"));
  expect(resolve("./value.cjs", [path.join(f.root, "absent"), alternate])).toBe(
    path.join(alternate, "value.cjs"),
  );
  expect(() => resolve("dep", [])).toThrow(
    expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }),
  );
  expect(() => resolve("vitest", [process.cwd()])).toThrow(
    expect.objectContaining({ code: "ERR_PLUGIN_SNAPSHOT_DEPENDENCY" }),
  );
});

it.each(["cjs", "ts"])(
  "preserves per-instance require.cache mutations for %s modules",
  async (extension) => {
    const operations = `
    const key = require.resolve('./peer.${extension}');
    const read = () => require('./peer.${extension}').token;
    const cached = () => require.cache[key]?.exports.token;
    const evict = () => { delete require.cache[key]; };
    const replace = (token) => { require.cache[key] = { id: key, filename: key, loaded: true, exports: { token } }; };
  `;
    const f = fixture({
      [`entry.${extension}`]:
        operations +
        (extension === "cjs"
          ? "module.exports = { read, cached, evict, replace };"
          : "export { read, cached, evict, replace };"),
      [`peer.${extension}`]:
        extension === "cjs"
          ? "module.exports = { token: {} };"
          : "export const token: object = {};",
      "native.mjs": `import * as peer from './peer.${extension}'; export const token = peer.token ?? peer.default.token;`,
    });
    type Controls = {
      read(): unknown;
      cached(): unknown;
      evict(): void;
      replace(token: unknown): void;
    };
    const observe = async (load: (entry: string) => unknown, other: (entry: string) => unknown) => {
      const a = (await load(`entry.${extension}`)) as Controls;
      const b = (await other(`entry.${extension}`)) as Controls;
      const first = a.read();
      const second = b.read();
      const stable = a.read() === first;
      const cached = a.cached() === first;
      const native = (await load("native.mjs")) as { token: unknown };
      a.evict();
      const reloaded = a.read();
      const injected = {};
      a.replace(injected);
      return {
        stable,
        cached,
        freshAfterDelete: reloaded !== first,
        injectedUsed: a.read() === injected,
        otherInstanceUnchanged: b.read() === second,
        nativeUnchanged: ((await load("native.mjs")) as { token: unknown }).token === native.token,
      };
    };
    const baselineA = cold.host(f.root);
    const baselineB = cold.host(f.root);
    const expected = await observe(
      (entry) => baselineA.load(entry),
      (entry) => baselineB.load(entry),
    );
    const coldCacheMutations = !(process.versions.bun && extension === "ts");
    expect(expected).toMatchObject({
      stable: true,
      // Bun's cold typed loader retains its own cache despite require.cache mutations.
      freshAfterDelete: coldCacheMutations,
      injectedUsed: coldCacheMutations,
      otherInstanceUnchanged: true,
      nativeUnchanged: true,
    });
    await baselineA.dispose();
    await baselineB.dispose();
    const a = f.loader();
    const b = f.loader();
    const load = (loader: typeof a, entry: string) =>
      entry.endsWith(".cjs")
        ? loader.requireModule(path.join(f.root, entry))
        : loader.importModule(path.join(f.root, entry));
    expect(
      await observe(
        (entry) => load(a, entry),
        (entry) => load(b, entry),
      ),
    ).toEqual({ ...expected, freshAfterDelete: true, injectedUsed: true });
  },
);

it("preserves self-deletion from require.cache through a captured dependency link", async () => {
  const f = fixture(
    {
      "package.json": '{"dependencies":{"dep":"1.0.0"}}',
      "entry.cjs": "exports.read = () => require('dep');",
      "store/dep/package.json": '{"name":"dep","main":"index.cjs"}',
      "store/dep/index.cjs":
        "module.exports = { token: {}, cached: require.cache[__filename] === module }; delete require.cache[__filename];",
    },
    { "node_modules/dep": "store/dep" },
  );
  const observe = (value: unknown) => {
    const entry = value as { read(): { token: unknown; cached: boolean } };
    const first = entry.read();
    const second = entry.read();
    return {
      cached: first.cached && second.cached,
      freshAfterDelete: first.token !== second.token,
    };
  };
  const baseline = cold.host(f.root);
  const expected = observe(baseline.load("entry.cjs"));
  expect(expected).toEqual({ cached: true, freshAfterDelete: true });
  await baseline.dispose();
  expect(observe(f.loader().requireModule(path.join(f.root, "entry.cjs")))).toEqual(expected);
});

it("re-verifies JSON after require.cache eviction without crossing instances", async () => {
  const f = fixture({
    "entry.cjs":
      "exports.read = () => require('./value.json'); exports.evict = () => { delete require.cache[require.resolve('./value.json')]; };",
    "entry.mjs": "import value from './value.json' with {type:'json'}; export {value};",
    "value.json": '{"answer":42}',
  });
  const first = f.loader();
  const second = f.loader();
  type Controls = { read(): { answer: number }; evict(): void };
  const a = first.requireModule(path.join(f.root, "entry.cjs")) as Controls;
  const b = second.requireModule(path.join(f.root, "entry.cjs")) as Controls;
  const value = a.read();
  const independent = b.read();
  expect(value).toEqual({ answer: 42 });
  expect(a.read()).toBe(value);
  expect(independent).toEqual(value);
  expect(independent).not.toBe(value);
  expect(await first.importModule(path.join(f.root, "entry.mjs"))).toMatchObject({ value });
  fs.writeFileSync(path.join(f.root, "value.json"), '{"answer":99}');
  a.evict();
  expect(() => a.read()).toThrow(`Corrupt module ${path.join(f.root, "value.json")}`);
  expect(b.read()).toBe(independent);
});

it.each(["cjs", "ts"])("preserves cold require resolution from a %s entry", async (extension) => {
  const body =
    "['./choice','main-choice','index-choice','./fallback'].map(name=>require('node:path').basename(require.resolve(name)))";
  const f = fixture({
    "package.json": '{"type":"commonjs"}',
    [`entry.${extension}`]:
      extension === "cjs" ? `module.exports=${body};` : `export const choices: string[]=${body};`,
    "choice.json": '"json"',
    "choice.mjs": "export default 'mjs';",
    "choice.ts": "export default 'ts';",
    "fallback.mjs": "export default 'fallback';",
    "node_modules/main-choice/package.json": '{"main":"./start"}',
    "node_modules/main-choice/start.mjs": "export default 'main';",
    "node_modules/main-choice/index.json": '"index"',
    "node_modules/index-choice/package.json": "{}",
    "node_modules/index-choice/index.mjs": "export default 'mjs';",
    "node_modules/index-choice/index.json": '"json"',
  });
  const entry = `entry.${extension}`;
  const baseline = cold.host(f.root);
  const choices = (value: unknown) =>
    extension === "cjs" ? value : (value as { choices: string[] }).choices;
  const expected = choices(await baseline.load(entry));
  expect(expected).toEqual(
    process.versions.bun
      ? [
          extension === "cjs" ? "choice.mjs" : "choice.ts",
          "index.json",
          "index.json",
          "fallback.mjs",
        ]
      : ["choice.json", "index.json", "index.json", "fallback.mjs"],
  );
  await baseline.dispose();
  const loader = f.loader();
  const loaded =
    extension === "cjs"
      ? loader.requireModule(path.join(f.root, entry))
      : await loader.importModule(path.join(f.root, entry));
  expect(choices(loaded)).toEqual(expected);
});

it.each(["mjs", "cjs", "tsx"])("loads verified JSX from a %s entry", async (extension) => {
  vi.stubEnv("JITI_JSX", "1");
  const entry = `entry.${extension}`;
  const f = fixture({
    "package.json": '{"type":"commonjs"}',
    [entry]:
      extension === "cjs"
        ? "module.exports = require('./view.jsx');"
        : `import { value } from './view.jsx'; export { value };${extension === "tsx" ? "const React = { createElement: (tag: string) => tag }; export const inline = <typed />;" : ""}`,
    "view.jsx":
      "const React = { createElement: (tag, props) => [tag, props.label] }; export const value = <view label='verified' />;",
  });
  const loader = f.loader();
  const value = (
    extension === "cjs"
      ? loader.requireModule(path.join(f.root, entry))
      : await loader.importModule(path.join(f.root, entry))
  ) as { value: string[]; inline?: string };
  expect(Array.from(value.value)).toEqual(["view", "verified"]);
  if (extension === "tsx") {
    expect(value.inline).toBe("typed");
  }
  expect(f.reads).toContain("view.jsx");
});

it.each([
  ["jsx", "dynamic"],
  ["jsx", "static"],
  ["ts", "dynamic"],
])("retains %s values and mode caches across %s-first edges", async (extension, firstEdge) => {
  vi.stubEnv("JITI_JSX", "1");
  const f = fixture({
    [`value.${extension}`]:
      extension === "jsx"
        ? "const React = { createElement: tag => ({ tag }) }; export const token = <view />;"
        : "export const token: { tag: string } = { tag: 'view' };",
    "static.mjs": `export { token } from './value.${extension}';`,
    "dynamic.mjs": `export const read = () => import('./value.${extension}');`,
    "typed.ts": `export { token } from './value.${extension}';`,
    "require.cjs": `module.exports = require('./value.${extension}');`,
  });
  type Value = { token: { tag: string } };
  type Dynamic = { read(): Promise<Value> };
  const assertEdges = async (load: (filename: string) => unknown, shared = true) => {
    const dynamic = (await load("dynamic.mjs")) as Dynamic;
    const first = (await (firstEdge === "dynamic" ? dynamic.read() : load("static.mjs"))) as Value;
    expect(first.token).toEqual({ tag: "view" });
    for (const filename of ["static.mjs", "typed.ts", "require.cjs"]) {
      const token = ((await load(filename)) as Value).token;
      expect(token).toEqual(first.token);
      if (shared) {
        expect(((await load(filename)) as Value).token).toBe(token);
      }
    }
    const token = (await dynamic.read()).token;
    expect(token).toEqual(first.token);
    if (shared) {
      expect((await dynamic.read()).token).toBe(token);
    }
  };
  const baseline = cold.host(f.root);
  await assertEdges((filename) => baseline.load(filename), false);
  await baseline.dispose();
  const loader = f.loader();
  await assertEdges((filename) =>
    filename.endsWith(".cjs")
      ? loader.requireModule(path.join(f.root, filename))
      : loader.importModule(path.join(f.root, filename)),
  );
});

it("preserves typed top-level await and CommonJS default imports", async () => {
  const f = fixture({
    "entry.ts":
      "import value from './value.cjs'; await Promise.resolve(); export const answer: number = value.answer; export default { answer };",
    "value.cjs": "module.exports = { answer: 42 };",
  });
  expect(await f.loader().importModule(path.join(f.root, "entry.ts"))).toMatchObject({
    answer: 42,
    default: { answer: 42 },
  });
});

it("retains Jiti marked default functions in typed imports", async () => {
  const f = fixture({
    "entry.ts":
      "import value from './value.cjs'; export const answer = value(); export const read = async () => (await import('./value.cjs')).default();",
    "value.cjs": "module.exports = { __esModule: true, default: () => 42 };",
  });
  const baseline = cold.host(f.root);
  const legacy = baseline.load("entry.ts") as { answer: number; read(): Promise<number> };
  expect(legacy.answer).toBe(42);
  expect(await legacy.read()).toBe(42);
  await baseline.dispose();
  const value = (await f.loader().importModule(path.join(f.root, "entry.ts"))) as typeof legacy;
  expect(value.answer).toBe(42);
  expect(await value.read()).toBe(42);
});

it("keeps typed dependency cycles in one in-memory mode cache", async () => {
  const f = fixture({
    "entry.ts":
      "import { next } from './peer.ts'; export let value = 40; export const read = () => next();",
    "peer.ts": "import { value } from './entry.ts'; export const next = () => value + 2;",
  });
  const value = (await f.loader().importModule(path.join(f.root, "entry.ts"))) as {
    read(): number;
  };
  expect(value.read()).toBe(42);
  expect(fs.readdirSync(f.root).toSorted()).toEqual(["entry.ts", "peer.ts"]);
});
