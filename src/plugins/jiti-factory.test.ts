import fs from "node:fs";
import path from "node:path";
import { createJiti as createExternalJiti } from "jiti";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

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
  }
  expect(acquire).toHaveBeenCalledOnce();
});
