import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rootAliasPath = require.resolve("./root-alias.cjs");
const jitiPath = require.resolve("jiti");

type CjsCacheEntry = {
  id: string;
  filename: string;
  loaded: boolean;
  exports: unknown;
};

type EmptySchema = {
  safeParse: (value: unknown) =>
    | { success: true; data?: unknown }
    | {
        success: false;
        error: { issues: Array<{ path: Array<string | number>; message: string }> };
      };
};

function loadRootSdk(stubExports: Record<string, unknown> = {}): Record<string, unknown> {
  const jitiStubModule: CjsCacheEntry = {
    id: jitiPath,
    filename: jitiPath,
    loaded: true,
    exports: {
      createJiti: () => () => stubExports,
    },
  };
  require.cache[jitiPath] = jitiStubModule as never;
  delete require.cache[rootAliasPath];
  return require(rootAliasPath) as Record<string, unknown>;
}

afterEach(() => {
  delete require.cache[rootAliasPath];
  delete require.cache[jitiPath];
});

describe("plugin-sdk root alias", () => {
  it("exposes the fast empty config schema helper", () => {
    const rootSdk = loadRootSdk();
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

  it("loads legacy root exports lazily through the proxy", () => {
    const rootSdk = loadRootSdk({
      resolveControlCommandGate() {
        return true;
      },
    });
    expect(typeof rootSdk.resolveControlCommandGate).toBe("function");
    expect(typeof rootSdk.default).toBe("object");
    expect(rootSdk.default).toBe(rootSdk);
    expect(rootSdk.__esModule).toBe(true);
  });

  it("preserves reflection semantics for lazily resolved exports", () => {
    const rootSdk = loadRootSdk({
      resolveControlCommandGate() {
        return true;
      },
    });
    expect("resolveControlCommandGate" in rootSdk).toBe(true);
    const keys = Object.keys(rootSdk);
    expect(keys).toContain("resolveControlCommandGate");
    const descriptor = Object.getOwnPropertyDescriptor(rootSdk, "resolveControlCommandGate");
    expect(descriptor).toBeDefined();
  });
});
