import { describe, expect, it } from "vitest";
import { createChannelsVitestConfig } from "../vitest.channels.config.ts";
import { createExtensionsVitestConfig } from "../vitest.extensions.config.ts";
import { createGatewayVitestConfig } from "../vitest.gateway.config.ts";
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
    const config = createScopedVitestConfig(["src/example.test.ts"], { env: {} });
    expect(config.test?.isolate).toBe(false);
  });

  it("passes through a scoped root dir when provided", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], {
      dir: "src",
      env: {},
    });
    expect(config.test?.dir).toBe("src");
    expect(config.test?.include).toEqual(["example.test.ts"]);
  });

  it("relativizes scoped include and exclude patterns to the configured dir", () => {
    const config = createScopedVitestConfig(["extensions/**/*.test.ts"], {
      dir: "extensions",
      env: {},
      exclude: ["extensions/channel/**", "dist/**"],
    });

    expect(config.test?.include).toEqual(["**/*.test.ts"]);
    expect(config.test?.exclude).toEqual(expect.arrayContaining(["channel/**", "dist/**"]));
  });
});

describe("scoped vitest configs", () => {
  const defaultChannelsConfig = createChannelsVitestConfig({});
  const defaultExtensionsConfig = createExtensionsVitestConfig({});
  const defaultGatewayConfig = createGatewayVitestConfig({});

  it("defaults channel tests to non-isolated mode", () => {
    expect(defaultChannelsConfig.test?.isolate).toBe(false);
  });

  it("defaults extension tests to non-isolated mode", () => {
    expect(defaultExtensionsConfig.test?.isolate).toBe(false);
  });

  it("normalizes extension include patterns relative to the scoped dir", () => {
    expect(defaultExtensionsConfig.test?.dir).toBe("extensions");
    expect(defaultExtensionsConfig.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes gateway include patterns relative to the scoped dir", () => {
    expect(defaultGatewayConfig.test?.dir).toBe("src/gateway");
    expect(defaultGatewayConfig.test?.include).toEqual(["**/*.test.ts"]);
  });
});
