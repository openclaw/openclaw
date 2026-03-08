import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rootSdk = require("./root-alias.cjs") as Record<string, unknown>;

type EmptySchema = {
  safeParse: (value: unknown) =>
    | { success: true; data?: unknown }
    | {
        success: false;
        error: { issues: Array<{ path: Array<string | number>; message: string }> };
      };
};

function readRequiredRootExports() {
  const scriptPath = path.resolve(
    import.meta.dirname,
    "../../scripts/check-plugin-sdk-exports.mjs",
  );
  const text = fs.readFileSync(scriptPath, "utf8");
  const match = text.match(/const requiredExports = \[(.*?)\];/s);
  if (!match) {
    throw new Error("requiredExports not found in check-plugin-sdk-exports.mjs");
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function readLegacyExportMap() {
  const shimPath = path.resolve(import.meta.dirname, "./root-alias.cjs");
  const text = fs.readFileSync(shimPath, "utf8");
  const match = text.match(/const legacyExportMap = \{([\s\S]*?)\n\};/);
  if (!match) {
    throw new Error("legacyExportMap not found in root-alias.cjs");
  }
  return Object.fromEntries(
    [...match[1].matchAll(/^\s+([A-Za-z0-9_]+): "([^"]+)",$/gm)].map(([, key, specifier]) => [
      key,
      specifier,
    ]),
  );
}

function createSourceLoader() {
  return createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  });
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

  it("loads legacy root exports lazily through the proxy", { timeout: 240_000 }, () => {
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

  it("exposes the required legacy root exports without loading the monolithic source entry", () => {
    const requiredExports = readRequiredRootExports();
    const legacyExportMap = readLegacyExportMap();
    const sourceLoader = createSourceLoader();

    for (const key of requiredExports) {
      expect(rootSdk, `missing root alias export ${key}`).toHaveProperty(key);
      const value = rootSdk[key];

      if (key === "emptyPluginConfigSchema") {
        expect(typeof value, `unexpected export type for ${key}`).toBe("function");
        continue;
      }

      const specifier = legacyExportMap[key];
      expect(specifier, `missing legacy export mapping for ${key}`).toBeDefined();
      const sourceModule = sourceLoader(path.resolve(import.meta.dirname, specifier));
      const sourceValue = sourceModule[key];

      expect(typeof value, `unexpected export type for ${key}`).toBe(typeof sourceValue);
      expect(value, `missing export value for ${key}`).not.toBeUndefined();
    }
  });
});
