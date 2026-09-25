import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

describe("plugin API runtime entrypoint", () => {
  it("preserves the selected main entry during setup registration without guessing an unselected entry", () => {
    const builder = createPluginRegistry({
      logger: console,
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
    const rootDir = path.resolve("plugins/fixture");
    const source = path.join(rootDir, "index.ts");
    const record = createPluginRecord({
      id: "fixture",
      source,
      rootDir,
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    expect(builder.createApi(record, { config: {} }).runtimeSource).toBeUndefined();

    const runtimeSource = path.join(rootDir, "dist/index.js");
    bindPluginRuntimeArtifactSelection(record, {
      runtimeEntry: { source: runtimeSource, rootDir },
      setupEntry: { source: path.join(rootDir, "dist/setup.js"), rootDir },
    });
    const api = builder.createApi(record, { config: {}, registrationMode: "setup-runtime" });
    expect(api.runtimeSource).toBe(runtimeSource);
    expect(api.source).toBe(source);
    expect(api.rootDir).toBe(rootDir);
  });
});
