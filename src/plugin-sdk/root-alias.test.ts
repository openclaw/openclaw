import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rootSdk = require("./root-alias.cjs") as Record<string, unknown>;
const rootAliasPath = fileURLToPath(new URL("./root-alias.cjs", import.meta.url));
const rootAliasSource = fs.readFileSync(rootAliasPath, "utf-8");

type EmptySchema = {
  safeParse: (value: unknown) =>
    | { success: true; data?: unknown }
    | {
        success: false;
        error: { issues: Array<{ path: Array<string | number>; message: string }> };
      };
};

function loadRootAliasWithStubs(options?: {
  distExists?: boolean;
  monolithicExports?: Record<string | symbol, unknown>;
}) {
  let createJitiCalls = 0;
  let jitiLoadCalls = 0;
  const createJitiOptions: Record<string, unknown>[] = [];
  const loadedSpecifiers: string[] = [];
  const monolithicExports = options?.monolithicExports ?? {
    slowHelper: () => "loaded",
  };
  const wrapper = vm.runInNewContext(
    `(function (exports, require, module, __filename, __dirname) {${rootAliasSource}\n})`,
    {},
    { filename: rootAliasPath },
  ) as (
    exports: Record<string, unknown>,
    require: NodeJS.Require,
    module: { exports: Record<string, unknown> },
    __filename: string,
    __dirname: string,
  ) => void;
  const module = { exports: {} as Record<string, unknown> };
  const localRequire = ((id: string) => {
    if (id === "node:path") {
      return path;
    }
    if (id === "node:fs") {
      return {
        existsSync: () => options?.distExists ?? false,
      };
    }
    if (id === "jiti") {
      return {
        createJiti(_filename: string, jitiOptions?: Record<string, unknown>) {
          createJitiCalls += 1;
          createJitiOptions.push(jitiOptions ?? {});
          return (specifier: string) => {
            jitiLoadCalls += 1;
            loadedSpecifiers.push(specifier);
            return monolithicExports;
          };
        },
      };
    }
    throw new Error(`unexpected require: ${id}`);
  }) as NodeJS.Require;
  wrapper(module.exports, localRequire, module, rootAliasPath, path.dirname(rootAliasPath));
  return {
    moduleExports: module.exports,
    get createJitiCalls() {
      return createJitiCalls;
    },
    get jitiLoadCalls() {
      return jitiLoadCalls;
    },
    get createJitiOptions() {
      return createJitiOptions;
    },
    loadedSpecifiers,
  };
}

describe("plugin-sdk root alias", () => {
  it("exposes the fast empty config schema helper", () => {
    const factory = rootSdk.emptyPluginConfigSchema as (() => EmptySchema) | undefined;
    expect(typeof factory).toBe("function");
    if (!factory) {
      return;
    }
    const schema = factory();
    expect(schema.safeParse(undefined)).toEqual({ success: true, data: undefined });
    expect(schema.safeParse({})).toEqual({ success: true, data: {} });
    const parsed = schema.safeParse({ invalid: true });
    expect(parsed.success).toBe(false);
  });

  it("does not load the monolithic sdk for fast helpers", () => {
    const lazyModule = loadRootAliasWithStubs();
    const lazyRootSdk = lazyModule.moduleExports;
    const factory = lazyRootSdk.emptyPluginConfigSchema as (() => EmptySchema) | undefined;

    expect(lazyModule.createJitiCalls).toBe(0);
    expect(lazyModule.jitiLoadCalls).toBe(0);
    expect(typeof factory).toBe("function");
    expect(factory?.().safeParse({})).toEqual({ success: true, data: {} });
    expect(lazyModule.createJitiCalls).toBe(0);
    expect(lazyModule.jitiLoadCalls).toBe(0);
  });

  it("does not load the monolithic sdk for promise-like or symbol reflection probes", () => {
    const lazyModule = loadRootAliasWithStubs();
    const lazyRootSdk = lazyModule.moduleExports;

    expect("then" in lazyRootSdk).toBe(false);
    expect(Reflect.get(lazyRootSdk, Symbol.toStringTag)).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(lazyRootSdk, Symbol.toStringTag)).toBeUndefined();
    expect(lazyModule.createJitiCalls).toBe(0);
    expect(lazyModule.jitiLoadCalls).toBe(0);
  });

  it("loads legacy root exports on demand and preserves reflection", () => {
    const lazyModule = loadRootAliasWithStubs({
      monolithicExports: {
        slowHelper: () => "loaded",
      },
    });
    const lazyRootSdk = lazyModule.moduleExports;

    expect(lazyModule.createJitiCalls).toBe(0);
    expect("slowHelper" in lazyRootSdk).toBe(true);
    expect(lazyModule.createJitiCalls).toBe(1);
    expect(lazyModule.jitiLoadCalls).toBe(1);
    expect(lazyModule.createJitiOptions.at(-1)?.tryNative).toBe(false);
    expect((lazyRootSdk.slowHelper as () => string)()).toBe("loaded");
    expect(Object.keys(lazyRootSdk)).toContain("slowHelper");
    expect(Object.getOwnPropertyDescriptor(lazyRootSdk, "slowHelper")).toBeDefined();
  });

  it("prefers native loading when compat resolves to dist", () => {
    const lazyModule = loadRootAliasWithStubs({
      distExists: true,
      monolithicExports: {
        slowHelper: () => "loaded",
      },
    });

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    expect(lazyModule.createJitiOptions.at(-1)?.tryNative).toBe(true);
  });

  it("forwards delegateCompactionToRuntime through the compat-backed root alias", () => {
    const delegateCompactionToRuntime = () => "delegated";
    const lazyModule = loadRootAliasWithStubs({
      monolithicExports: {
        delegateCompactionToRuntime,
      },
    });
    const lazyRootSdk = lazyModule.moduleExports;

    expect(typeof lazyRootSdk.delegateCompactionToRuntime).toBe("function");
    expect(lazyRootSdk.delegateCompactionToRuntime).toBe(delegateCompactionToRuntime);
    expect("delegateCompactionToRuntime" in lazyRootSdk).toBe(true);
  });

  it("loads legacy root exports through the merged root wrapper", { timeout: 240_000 }, () => {
    expect(typeof rootSdk.resolveControlCommandGate).toBe("function");
    expect(typeof rootSdk.default).toBe("object");
    expect(rootSdk.default).toBe(rootSdk);
    expect(rootSdk.__esModule).toBe(true);
  });

  it("preserves reflection semantics for lazily resolved exports", { timeout: 240_000 }, () => {
    expect("resolveControlCommandGate" in rootSdk).toBe(true);
    const keys = Object.keys(rootSdk);
    expect(keys).toContain("resolveControlCommandGate");
    const descriptor = Object.getOwnPropertyDescriptor(rootSdk, "resolveControlCommandGate");
    expect(descriptor).toBeDefined();
  });
});
