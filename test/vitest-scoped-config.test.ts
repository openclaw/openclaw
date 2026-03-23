import { describe, expect, it } from "vitest";
import channelsConfig from "../vitest.channels.config.ts";
import extensionsConfig from "../vitest.extensions.config.ts";
import { createScopedVitestConfig, resolveVitestIsolation } from "../vitest.scoped-config.ts";

describe("resolveVitestIsolation", () => {
  it("defaults shared scoped configs to non-isolated workers", () => {
    expect(resolveVitestIsolation({})).toBe(false);
  });

  it("restores isolate mode when explicitly requested", () => {
    expect(resolveVitestIsolation({ OPENCLAW_TEST_ISOLATE: "1" })).toBe(true);
    expect(resolveVitestIsolation({ OPENCLAW_TEST_NO_ISOLATE: "0" })).toBe(true);
    expect(resolveVitestIsolation({ OPENCLAW_TEST_NO_ISOLATE: "false" })).toBe(true);
  });
});

describe("createScopedVitestConfig", () => {
  it("applies non-isolated mode by default", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"]);
    expect(config.test?.isolate).toBe(false);
  });
});

describe("scoped vitest configs", () => {
  it("defaults channel tests to non-isolated mode", () => {
    expect(channelsConfig.test?.isolate).toBe(false);
  });

  it("defaults extension tests to non-isolated mode", () => {
    expect(extensionsConfig.test?.isolate).toBe(false);
  });
});
