import { describe, expectTypeOf, it } from "vitest";
import { createPluginRuntime } from "./index.js";
import type { PluginRuntime } from "./types.js";

describe("plugin runtime type contract", () => {
  it("createPluginRuntime returns the declared PluginRuntime shape", () => {
    const runtime = createPluginRuntime();
    expectTypeOf(runtime).toMatchTypeOf<PluginRuntime>();
    expectTypeOf<PluginRuntime>().toMatchTypeOf(runtime);
  });
});
