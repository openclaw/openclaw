import fs from "node:fs";
import path from "node:path";
import { createJiti as createExternalJiti } from "jiti";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

/* oxlint-disable typescript/unbound-method -- These tests compare V8's formatter callback by identity. */

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());

it("acquires the standalone factory lazily once and shares host SDK values across source formats", async () => {
  const root = temporary.make("standalone-plugin-factory-");
  const dependency = path.join(root, "dependency.cjs");
  fs.writeFileSync(
    dependency,
    'exports.read = () => require("node:querystring").parse("value=42").value;',
  );
  for (const extension of ["cjs", "mjs", "ts"]) {
    fs.writeFileSync(
      path.join(root, `plugin.${extension}`),
      extension === "cjs"
        ? 'const {marker} = require("openclaw/plugin-sdk/fixture"); const {read} = require("./dependency.cjs"); module.exports = {marker, value: read()};'
        : 'import {marker} from "openclaw/plugin-sdk/fixture"; import {read} from "./dependency.cjs"; export {marker}; export const value = read();',
    );
  }
  const acquire = vi.fn(() => createExternalJiti);
  vi.stubGlobal("openclawStandaloneLoadJitiFactory", acquire);
  const { createJiti } = await import("./jiti-factory.js");
  expect(acquire).not.toHaveBeenCalled();
  const marker = {};
  const prepareStackTrace = Error.prepareStackTrace;
  for (const extension of ["cjs", "mjs", "ts"]) {
    const loader = createJiti(import.meta.url, {
      tryNative: false,
      fsCache: false,
      moduleCache: false,
      virtualModules: { "openclaw/plugin-sdk/fixture": { marker } },
    });
    const loaded = loader(path.join(root, `plugin.${extension}`));
    expect(loaded.marker).toBe(marker);
    expect(loaded.value).toBe("42");
    expect(Error.prepareStackTrace).toBe(prepareStackTrace);
  }
  expect(acquire).toHaveBeenCalledOnce();
});

it("keeps Babel diagnostic filtering local to repeated source transforms", async () => {
  const { createJiti } = await import("./jiti-factory.js");
  const loader = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const prepareStackTrace = Error.prepareStackTrace;
  const callerFormatter = vi.fn(prepareStackTrace);
  Error.prepareStackTrace = callerFormatter;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = loader.options.transform!({
        source: "export const value: number = 42;",
        filename: "plugin.ts",
        ts: true,
        babel: { sourceType: "invalid" },
      });
      expect(Error.prepareStackTrace).toBe(callerFormatter);
      expect(result.error).toBeInstanceOf(Error);
      const diagnostic = result.error as Error;
      expect(diagnostic.message).toContain(".sourceType must be");
      expect(diagnostic.stack).toContain(diagnostic.message);
      expect(diagnostic.stack).not.toContain("stopHiding");
      expect(diagnostic.stack).not.toContain("loadPrivatePartialConfig");
    }
    expect(() =>
      loader.options.transform!({
        source: "",
        get babel(): never {
          throw new Error("unreadable transform options");
        },
      }),
    ).toThrow("unreadable transform options");
    expect(Error.prepareStackTrace).toBe(callerFormatter);
    callerFormatter.mockClear();
    expect(new Error("runtime failure").stack).toContain("runtime failure");
    expect(callerFormatter).toHaveBeenCalledOnce();
    const customTransform = vi.fn(() => ({ code: "module.exports = 42;" }));
    const customLoader = createJiti(import.meta.url, { transform: customTransform });
    expect(customLoader.options.transform).toBe(customTransform);
  } finally {
    Error.prepareStackTrace = prepareStackTrace;
  }
});
