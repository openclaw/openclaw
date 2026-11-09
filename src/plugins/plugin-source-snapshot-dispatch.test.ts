import { randomUUID } from "node:crypto";
import Module, { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createPluginSnapshotDispatch } from "./plugin-source-snapshot-dispatch.js";
import { state, type Runtime } from "./plugin-source-snapshot-module-hooks.js";

it("preserves live facade identities and revokes every retained owner bridge", async () => {
  const id = randomUUID();
  let calls = 0;
  let scopedBuiltins = true;
  const touch = () => calls++;
  const cache: NodeJS.Dict<NodeJS.Module> = Object.create(null);
  const workers = {
    Worker: class {
      constructor(readonly value: string) {
        touch();
      }
    },
  };
  const processes = {
    fork: () => {
      touch();
      return "child";
    },
  };
  const native = createRequire(import.meta.url);
  const scoped: NodeJS.Require = Object.assign(
    (request: string) => {
      touch();
      if (request === "module" || request === "node:module") {
        return facade;
      }
      if (request === "worker_threads" || request === "node:worker_threads") {
        return scopedBuiltins ? workers : native("node:worker_threads");
      }
      if (request === "child_process" || request === "node:child_process") {
        return scopedBuiltins ? processes : native("node:child_process");
      }
      return "value";
    },
    native,
    {
      cache,
      resolve: Object.assign(() => {
        touch();
        return "/module.cjs";
      }, native.resolve),
    },
  );
  Object.defineProperty(scoped, "main", {
    configurable: true,
    get: () => {
      touch();
      return undefined;
    },
  });
  const prototype = new Proxy(Module.prototype, {
    get(target, key, receiver) {
      return key === "constructor"
        ? facade
        : key === "require"
          ? scoped
          : Reflect.get(target, key, receiver);
    },
  });
  const facade: typeof Module = new Proxy(Module, {
    get(target, key, receiver) {
      if (key === "Module") {
        return facade;
      }
      if (key === "prototype") {
        return prototype;
      }
      if (key === "createRequire") {
        return scopedCreateRequire;
      }
      if (key === "_load") {
        return scoped;
      }
      if (key === "_resolveFilename") {
        return scoped.resolve;
      }
      if (key === "_cache") {
        return cache;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const scopedCreateRequire = (anchor: string | URL) => {
    createRequire(anchor);
    touch();
    return scoped;
  };
  const metadata = {
    url: "file:///module.mjs",
    resolve: () => {
      touch();
      return "resolved";
    },
    require: scoped,
  };
  const importer = async () => {
    touch();
    return "imported";
  };
  const dispatch = createPluginSnapshotDispatch(id);
  const runtime: Runtime = {
    dispatch,
    compileCommonJs() {},
    requireFor: () => scoped,
    moduleFacade: facade,
    importFor: () => importer,
    meta: () => metadata,
    resolveFrom: () => "",
    registerModule() {},
    assertMember() {},
    loadNode: () => "",
    loadBun: () => ({ contents: "", loader: "js" }),
    importModule: importer,
    requireModule: scoped,
    evaluateSource: () => "",
    dispose() {},
    intercept: () => undefined,
    loadNative: () => "",
  };
  state.instances.set(id, runtime);
  try {
    const M = dispatch.moduleFacade;
    const makeRequire = M.createRequire;
    const require = makeRequire(import.meta.url);
    const resolve = require.resolve;
    const main = Reflect.get(Object.getOwnPropertyDescriptor(require, "main")!, "get")!;
    const retainedCache = require.cache;
    const retainedMeta = dispatch.meta("/module.mjs", "");
    const metaResolve = Reflect.get(retainedMeta, "resolve") as typeof metadata.resolve;
    const metaRequire = Reflect.get(retainedMeta, "require") as typeof metadata.require;
    const load = dispatch.importFor("/module.mjs");
    const Worker = Reflect.get(
      Object(dispatch.builtin("node:worker_threads", "/module.cjs")),
      "Worker",
    );
    const fork = Reflect.get(Object(require("node:child_process")), "fork");
    expect(M.Module).toBe(M);
    expect(require("node:module")).toBe(M);
    expect(M.prototype.constructor).toBe(M);
    expect(require.cache).toBe(Reflect.get(M, "_cache"));
    expect(Object.getOwnPropertyDescriptor(require, "cache")!.value).toBe(retainedCache);
    expect(Object.getOwnPropertyDescriptor(retainedMeta, "resolve")!.value).toBe(metaResolve);
    expect(Reflect.get(Object(require("node:worker_threads")), "Worker")).toBe(Worker);
    expect(Reflect.get(Object(dispatch.builtin("child_process", "/module.cjs")), "fork")).toBe(
      fork,
    );
    expect(Reflect.construct(Worker, ["worker"])).toMatchObject({ value: "worker" });
    expect(fork()).toBe("child");
    expect(resolve("module")).toBe("/module.cjs");
    expect(metaResolve()).toBe("resolved");
    expect(metaRequire("module")).toBe(M);
    expect(await load("module")).toBe("imported");
    const cached = new Module("/cached.cjs");
    retainedCache["/cached.cjs"] = cached;
    expect(cache["/cached.cjs"]).toBe(cached);
    delete retainedCache["/cached.cjs"];
    expect(cache).not.toHaveProperty("/cached.cjs");

    scopedBuiltins = false;
    expect(dispatch.builtin("node:worker_threads", "/module.cjs")).toBe(
      native("node:worker_threads"),
    );
    expect(require("node:worker_threads")).toBe(native("node:worker_threads"));
    expect(dispatch.builtin("node:child_process", "/module.cjs")).toBe(
      native("node:child_process"),
    );
    expect(require("node:child_process")).toBe(native("node:child_process"));
    scopedBuiltins = true;
    dispatch.dispose();
    state.instances.delete(id);
    const before = calls;
    for (const operation of [
      () => makeRequire(import.meta.url),
      () => require("node:module"),
      () => resolve("module"),
      () => main(),
      () => retainedCache["/cached.cjs"],
      () => Reflect.get(M, "createRequire"),
      () => metaResolve(),
      () => metaRequire("module"),
      () => load("module"),
      () => Reflect.construct(Worker, []),
      () => fork(),
    ]) {
      expect(operation).toThrow(/revoked/);
    }
    expect(calls).toBe(before);
    expect(() => dispatch.requireFor("/module.cjs")).toThrow(/disposed/);
  } finally {
    dispatch.dispose();
    state.instances.delete(id);
  }
});
