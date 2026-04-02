import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rootAliasPath = fileURLToPath(new URL("../../plugin-sdk/root-alias.cjs", import.meta.url));
const rootSdk = require(rootAliasPath) as Record<string, unknown>;
const rootAliasSource = fs.readFileSync(rootAliasPath, "utf-8");
const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));

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
  distEntries?: string[];
  env?: Record<string, string | undefined>;
  monolithicExports?: Record<string | symbol, unknown>;
  aliasPath?: string;
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
    {
      process: {
        env: options?.env ?? {},
      },
    },
    { filename: rootAliasPath },
  ) as (
    exports: Record<string, unknown>,
    require: NodeJS.Require,
    module: { exports: Record<string, unknown> },
    __filename: string,
    __dirname: string,
  ) => void;
  const module = { exports: {} as Record<string, unknown> };
  const aliasPath = options?.aliasPath ?? rootAliasPath;
  const localRequire = ((id: string) => {
    if (id === "node:path") {
      return path;
    }
    if (id === "node:fs") {
      return {
        readFileSync: () =>
          JSON.stringify({
            exports: {
              "./plugin-sdk/group-access": { default: "./dist/plugin-sdk/group-access.js" },
            },
          }),
        existsSync: (targetPath: string) => {
          if (targetPath.endsWith(path.join("dist", "infra", "diagnostic-events.js"))) {
            return options?.distExists ?? false;
          }
          return options?.distExists ?? false;
        },
        readdirSync: () =>
          (options?.distEntries ?? []).map((name) => ({
            name,
            isFile: () => true,
            isDirectory: () => false,
          })),
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
  wrapper(module.exports, localRequire, module, aliasPath, path.dirname(aliasPath));
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

function createPackageRoot() {
  return path.dirname(path.dirname(rootAliasPath));
}

function createDistAliasPath() {
  return path.join(createPackageRoot(), "dist", "plugin-sdk", "root-alias.cjs");
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
        slowHelper: (): string => "loaded",
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

  it.each([
    {
      name: "prefers source loading when the source root alias runs in development",
      options: {
        distExists: true,
        env: { NODE_ENV: "development" },
        monolithicExports: {
          slowHelper: (): string => "loaded",
        },
      },
      expectedTryNative: false,
    },
    {
      name: "prefers native loading when compat resolves to dist",
      options: {
        distExists: true,
        env: { NODE_ENV: "production" },
        monolithicExports: {
          slowHelper: (): string => "loaded",
        },
      },
      expectedTryNative: true,
    },
    {
      name: "prefers source loading under vitest even when compat resolves to dist",
      options: {
        distExists: true,
        env: { VITEST: "1" },
        monolithicExports: {
          slowHelper: (): string => "loaded",
        },
      },
      expectedTryNative: false,
    },
  ])("$name", ({ options, expectedTryNative }) => {
    const lazyModule = loadRootAliasWithStubs(options);

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    expect(lazyModule.createJitiOptions.at(-1)?.tryNative).toBe(expectedTryNative);
  });

  it("falls back to src files even when the alias itself is loaded from dist", () => {
    const packageRoot = createPackageRoot();
    const distAliasPath = createDistAliasPath();
    const lazyModule = loadRootAliasWithStubs({
      aliasPath: distAliasPath,
      distExists: false,
      monolithicExports: {
        onDiagnosticEvent: (): (() => void) => () => undefined,
        slowHelper: (): string => "loaded",
      },
    });

    expect((lazyModule.moduleExports.slowHelper as () => string)()).toBe("loaded");
    expect(lazyModule.loadedSpecifiers).toContain(
      path.join(packageRoot, "src", "plugin-sdk", "compat.ts"),
    );
    expect(
      typeof (lazyModule.moduleExports.onDiagnosticEvent as (listener: () => void) => () => void)(
        () => undefined,
      ),
    ).toBe("function");
    expect(lazyModule.loadedSpecifiers).toContain(
      path.join(packageRoot, "src", "infra", "diagnostic-events.ts"),
    );
  });

  it("prefers hashed dist diagnostic events chunks before falling back to src", () => {
    const packageRoot = createPackageRoot();
    const distAliasPath = createDistAliasPath();
    const lazyModule = loadRootAliasWithStubs({
      aliasPath: distAliasPath,
      distExists: false,
      distEntries: ["diagnostic-events-W3Hz61fI.js"],
      monolithicExports: {
        r: (): (() => void) => () => undefined,
        slowHelper: (): string => "loaded",
      },
    });

    expect(
      typeof (lazyModule.moduleExports.onDiagnosticEvent as (listener: () => void) => () => void)(
        () => undefined,
      ),
    ).toBe("function");
    expect(lazyModule.loadedSpecifiers).toContain(
      path.join(packageRoot, "dist", "diagnostic-events-W3Hz61fI.js"),
    );
    expect(lazyModule.loadedSpecifiers).not.toContain(
      path.join(packageRoot, "src", "infra", "diagnostic-events.ts"),
    );
  });

  it.each([
    {
      name: "forwards delegateCompactionToRuntime through the compat-backed root alias",
      exportName: "delegateCompactionToRuntime",
      exportValue: () => "delegated",
      expectIdentity: true,
      assertForwarded: (value: unknown) => {
        expect(typeof value).toBe("function");
        expect((value as () => string)()).toBe("delegated");
      },
    },
    {
      name: "forwards onDiagnosticEvent through the compat-backed root alias",
      exportName: "onDiagnosticEvent",
      exportValue: () => () => undefined,
      expectIdentity: false,
      assertForwarded: (value: unknown) => {
        expect(typeof value).toBe("function");
        expect(typeof (value as (listener: () => void) => () => void)(() => undefined)).toBe(
          "function",
        );
      },
    },
  ])("$name", ({ exportName, exportValue, expectIdentity, assertForwarded }) => {
    const lazyModule = loadRootAliasWithStubs({
      monolithicExports: {
        [exportName]: exportValue,
      },
    });
    const forwarded = lazyModule.moduleExports[exportName];

    assertForwarded(forwarded);
    if (expectIdentity) {
      expect(forwarded).toBe(exportValue);
    }
    expect(exportName in lazyModule.moduleExports).toBe(true);
  });

  it("loads legacy root exports through the merged root wrapper", { timeout: 240_000 }, () => {
    expect(typeof rootSdk.resolveControlCommandGate).toBe("function");
    expect(typeof rootSdk.onDiagnosticEvent).toBe("function");
    expect(typeof rootSdk.default).toBe("object");
    expect(rootSdk.default).toBe(rootSdk);
    expect(rootSdk.__esModule).toBe(true);
  });

  it("publishes the Discord plugin-sdk subpath", () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports?.["./plugin-sdk/discord"]).toBeDefined();
  });

  it("preserves reflection semantics for lazily resolved exports", { timeout: 240_000 }, () => {
    expect("resolveControlCommandGate" in rootSdk).toBe(true);
    expect("onDiagnosticEvent" in rootSdk).toBe(true);
    const keys = Object.keys(rootSdk);
    expect(keys).toContain("resolveControlCommandGate");
    expect(keys).toContain("onDiagnosticEvent");
    const descriptor = Object.getOwnPropertyDescriptor(rootSdk, "resolveControlCommandGate");
    expect(descriptor).toBeDefined();
    expect(Object.getOwnPropertyDescriptor(rootSdk, "onDiagnosticEvent")).toBeDefined();
  });
});
