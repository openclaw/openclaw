import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginSharedSnapshotModuleLoader } from "./plugin-source-snapshot-loader.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-byte-loader-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = new Map<string, { kind: "file" | "directory" }>();
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
  const snapshot = {
    rootDir: root,
    payloadRoot: root,
    sourceAliases: {},
    sourceLinks: new Map<string, string>(),
    entries,
    resolution,
    configuration,
    assertCurrent() {},
    assertMemberPath(filename: string) {
      if (!expected.has(filename)) {
        throw new Error(`Unowned module ${filename}`);
      }
    },
    readVerifiedFile(filename: string) {
      reads.push(path.relative(root, filename));
      const contents = fs.readFileSync(filename);
      if (contents.toString("utf8") !== expected.get(filename)) {
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
