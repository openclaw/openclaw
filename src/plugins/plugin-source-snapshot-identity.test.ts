import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createPluginSharedSnapshotModuleLoader } from "./plugin-source-snapshot-loader.js";
import { state } from "./plugin-source-snapshot-module-hooks.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

function fixture(files: Record<string, string>, interceptSourcePaths = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-identity-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = new Map<string, { kind: "file" | "directory" }>([[root, { kind: "directory" }]]);
  const expected = new Map<string, string>();
  const resolution = new Map<string, string>();
  for (const [name, source] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.writeFileSync(filename, source);
    entries.set(filename, { kind: "file" });
    expected.set(filename, source);
    if (name === "package.json") {
      resolution.set(root, source);
    }
  }
  const readVerifiedFile = (filename: string) => {
    const bytes = fs.readFileSync(filename);
    if (bytes.toString() !== expected.get(filename)) {
      throw new Error("snapshot bytes changed");
    }
    return bytes;
  };
  const options = {
    interceptSourcePaths,
    snapshot: {
      rootDir: root,
      payloadRoot: root,
      sourceAliases: {},
      sourceLinks: new Map(),
      entries,
      resolution,
      configuration: new Map(),
      assertCurrent() {},
      assertMemberPath(filename: string) {
        if (!entries.has(filename)) {
          throw new Error("outside snapshot");
        }
      },
      readVerifiedFile,
    },
    loadNativeModule() {
      throw new Error("unexpected native module");
    },
  };
  const loader = createPluginSharedSnapshotModuleLoader(options);
  cleanups.push(loader.dispose);
  return { root, loader, options, file: (name: string) => path.join(root, name), readVerifiedFile };
}

it.each(["ts", "cts"])("keeps repeated %s query imports on verified bytes", async (extension) => {
  const f = fixture({
    "entry.mjs": "export const read = name => import(name);",
    ["value." + extension]: "const value:number=42;module.exports={value};",
  });
  const entry = (await f.loader.importModule(f.file("entry.mjs"))) as {
    read(name: string): Promise<{ value: number }>;
  };
  const request = "./value." + extension + "?one#fragment";
  const first = await entry.read(request);
  fs.writeFileSync(f.file("value." + extension), "const value:number=99;module.exports={value};");
  expect(() => f.readVerifiedFile(f.file("value." + extension))).toThrow("snapshot bytes changed");
  expect(await entry.read(request)).toBe(first);
  expect(first.value).toBe(42);
});

it.each(["cts", "ts", "mts"])("preserves %s suffix identity and metadata", async (extension) => {
  const commonjs = extension === "cts";
  const f = fixture({
    "package.json": '{"type":"module"}',
    "entry.mjs": "export const read = name => import(name);",
    ["value." + extension]: commonjs
      ? "module.exports={token:{}};"
      : "export const token:object={};export const location=import.meta.url;",
  });
  type Value = { token: object; location?: string };
  const entry = (await f.loader.importModule(f.file("entry.mjs"))) as {
    read(name: string): Promise<Value>;
  };
  const suffixes = ["?one", "#two", "?three#four"];
  const values: Value[] = [];
  for (const suffix of suffixes) {
    const request = "./value." + extension + suffix;
    const value = await entry.read(request);
    values.push(value);
    expect((await entry.read(request)).token).toBe(value.token);
    if (!commonjs) {
      expect(value.location).toBe(pathToFileURL(f.file("value." + extension)).href + suffix);
    }
  }
  expect(new Set(values.map((value) => value.token)).size).toBe(
    commonjs && !process.versions.bun ? 1 : suffixes.length,
  );
});

it.each(
  ["ts", "mts"].flatMap((extension) => ["static", "dynamic"].map((first) => [extension, first])),
)("shares %s identity across %s-first imports", async (extension, first) => {
  const f = fixture({
    "package.json": '{"type":"module"}',
    "entry.mjs": "export const read = name => import(name);",
    "static.mjs": "export {token} from './value." + extension + "';",
    ["value." + extension]: "export const token:object={};",
  });
  const entry = (await f.loader.importModule(f.file("entry.mjs"))) as {
    read(name: string): Promise<{ token: object }>;
  };
  const names = ["./static.mjs", "./value." + extension];
  if (first === "dynamic") {
    names.reverse();
  }
  expect((await entry.read(names[0]!)).token).toBe((await entry.read(names[1]!)).token);
});

it("evaluates a typed wildcard barrel once across its compiler self import", async () => {
  const counter = "__snapshot_" + randomUUID();
  cleanups.push(() => {
    Reflect.deleteProperty(globalThis, counter);
  });
  const f = fixture({
    "entry.mjs": "export * from './barrel.mts';",
    "barrel.mts":
      "globalThis[" +
      JSON.stringify(counter) +
      "]=(globalThis[" +
      JSON.stringify(counter) +
      "]??0)+1;export * from './leaf.mts';",
    "leaf.mts": "export const value:number=42;",
  });
  expect(await f.loader.importModule(f.file("entry.mjs"))).toMatchObject({ value: 42 });
  expect(Reflect.get(globalThis, counter)).toBe(1);
});

it.each([false, true])("rejects unregistered internal URLs after disposal=%s", async (disposed) => {
  const f = fixture({ "value.mjs": "export const value=42;" });
  await f.loader.importModule(f.file("value.mjs"));
  const url = [...state.paths].find(
    ([key, owned]) => key.startsWith("file:") && owned.module.filename === f.file("value.mjs"),
  )![0];
  const helper = f.file("native-import.cjs");
  fs.writeFileSync(helper, "exports.load = name => import(name);");
  const native = createRequire(import.meta.url)(helper) as {
    load(name: string): Promise<unknown>;
  };
  if (disposed) {
    f.loader.dispose();
  }
  fs.writeFileSync(f.file("value.mjs"), "export const value=99;");
  expect(() => f.readVerifiedFile(f.file("value.mjs"))).toThrow("snapshot bytes changed");
  const privateFile = path.join(f.root, ".openclaw-snapshot-instance-stale", "value.mjs");
  fs.mkdirSync(path.dirname(privateFile));
  fs.writeFileSync(privateFile, "export const value=99;");
  for (const request of [
    url + "&unexpected=1",
    url.replace("__openclaw_instance", "%5F%5Fopenclaw_instance") + "&unexpected=2",
    url + "?unexpected=3",
    f.file("value.mjs") + "?%5F%5Fopenclaw_instance=unregistered",
    url.slice(0, url.indexOf("?")) + "?__openclaw_instance",
    pathToFileURL(privateFile).href.replace(".openclaw", "%2eopenclaw"),
    privateFile.replace(".openclaw", "%2eopenclaw"),
    privateFile.replace(".openclaw", ".OPENCLAW"),
  ]) {
    await expect(native.load(request)).rejects.toThrow(/unregistered|disposed/);
  }
  for (const request of [
    url.replace("file:", "FiLe:").replace("__openclaw_instance", "%5F%5Fopenclaw_instance") +
      "&other=4",
    " " + url.replace("file:", "fi\tle:") + "&other=5",
  ]) {
    const result = expect(native.load(request)).rejects;
    if (process.versions.bun) {
      // Bun rejects these spellings before the hook; Node normalizes them as file URLs.
      await result.toThrow();
    } else {
      await result.toThrow(/unregistered|disposed/);
    }
  }
});

it("keeps marked CJS default interop in every typed ESM import view", async () => {
  const f = fixture({
    "package.json": '{"type":"module"}',
    "entry.ts": `import value from './value.cjs';
      import * as namespace from './value.cjs';
      export {default as forwarded} from './value.cjs';
      export const direct=value; export const namespaced=namespace.default;
      export const read=()=>import('./value.cjs');`,
    "value.cjs": "module.exports={__esModule:true,default:()=>42};",
  });
  const value = (await f.loader.importModule(f.file("entry.ts"))) as {
    direct: () => number;
    namespaced: () => number;
    forwarded: () => number;
    read: () => Promise<{ default: () => number }>;
  };
  expect(value.direct()).toBe(42);
  expect(value.namespaced).toBe(value.direct);
  expect(value.forwarded).toBe(value.direct);
  expect((await value.read()).default).toBe(value.direct);
});

it("keeps native source interception within the registered execution URL", async () => {
  const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-intercept-host-"));
  cleanups.push(() => fs.rmSync(helperRoot, { recursive: true, force: true }));
  const helper = path.join(helperRoot, "native-import.cjs");
  fs.writeFileSync(helper, "exports.load = name => import(name);");
  const native = createRequire(import.meta.url)(helper) as {
    load(name: string): Promise<{ value: number }>;
  };
  const f = fixture({ "value.mjs": "export const value=42;" }, true);
  const first = await native.load(pathToFileURL(f.file("value.mjs")).href);
  expect(first.value).toBe(42);
  fs.writeFileSync(f.file("value.mjs"), "export const value=99;");
  expect(await native.load(pathToFileURL(f.file("value.mjs")).href)).toBe(first);
});

it("leaves unrelated host query and fragment imports with the native loader", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-unrelated-host-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, "native-import.cjs");
  fs.writeFileSync(helper, "exports.load = name => import(name);");
  const native = createRequire(import.meta.url)(helper) as {
    load(name: string): Promise<{ value: number }>;
  };
  fixture({ "value.mjs": "export const value=0;" });
  const file = path.join(root, "host.mjs");
  fs.writeFileSync(file, "export const value=42;");
  for (const suffix of ["?ordinary=1", "#ordinary", "?percent=%20"]) {
    expect((await native.load(pathToFileURL(file).href + suffix)).value).toBe(42);
  }
});

it("rejects caller-supplied execution markers through verified loader APIs", async () => {
  const f = fixture({
    "entry.mjs": `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);
      export const read=name=>import(name); export const load=name=>require(name);
      export const resolve=name=>import.meta.resolve(name);`,
    "value.mjs": "export const token={};",
  });
  const entry = (await f.loader.importModule(f.file("entry.mjs"))) as {
    read: (name: string) => Promise<unknown>;
    load: (name: string) => unknown;
    resolve: (name: string) => string;
  };
  const execution = async (loader: typeof f.loader) => {
    await loader.importModule(f.file("value.mjs"));
    return [...state.paths].find(
      ([key, owned]) =>
        key.startsWith("file:") &&
        owned.runtime === loader &&
        owned.module.filename === f.file("value.mjs"),
    )![0];
  };
  const own = await execution(f.loader);
  const disposed = createPluginSharedSnapshotModuleLoader(f.options);
  const stale = await execution(disposed);
  disposed.dispose();
  const foreign = createPluginSharedSnapshotModuleLoader(f.options);
  cleanups.push(foreign.dispose);
  const live = await execution(foreign);
  for (const request of [
    "./value.mjs?__openclaw_instance=unknown",
    "./value.mjs?%5F%5Fopenclaw_instance=unknown",
    own,
    own + "&__openclaw_instance=another",
    stale,
    live,
    live.replace("__openclaw_instance", "%5F%5Fopenclaw_instance"),
  ]) {
    await expect(entry.read(request)).rejects.toThrow(/reserved|unregistered|disposed/);
    expect(() => entry.load(request)).toThrow(/reserved|unregistered|disposed/);
    expect(() => entry.resolve(request)).toThrow(/reserved|unregistered|disposed/);
  }
});
