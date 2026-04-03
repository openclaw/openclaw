import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_LIVE_TEST_GLOB } from "../../vitest.bundled-plugin-paths.ts";
import liveConfig from "../../vitest.live.config.ts";

describe("live vitest config", () => {
  it("runs as a standalone config instead of inheriting unit projects", () => {
    expect(liveConfig.test?.projects).toBeUndefined();
  });

  it("includes live test globs and runtime setup", () => {
    expect(liveConfig.test?.include).toEqual([
      "src/**/*.live.test.ts",
      BUNDLED_PLUGIN_LIVE_TEST_GLOB,
    ]);
    expect(liveConfig.test?.setupFiles).toContain("test/setup-openclaw-runtime.ts");
  });
});
