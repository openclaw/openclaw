import { describe, expect, it } from "vitest";
import { createScopedVitestConfig, resolveVitestIsolation } from "../vitest.scoped-config.ts";

async function withEnvValue<T>(
  key: string,
  value: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

async function importFreshConfig<T>(specifier: string): Promise<T> {
  return (await import(`${specifier}?t=${Date.now()}`)) as T;
}

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

  it("passes through a scoped root dir when provided", () => {
    const config = createScopedVitestConfig(["src/example.test.ts"], {
      dir: "src",
    });
    expect(config.test?.dir).toBe("src");
    expect(config.test?.include).toEqual(["example.test.ts"]);
  });

  it("relativizes scoped include and exclude patterns to the configured dir", () => {
    const config = createScopedVitestConfig(["extensions/**/*.test.ts"], {
      dir: "extensions",
      exclude: ["extensions/channel/**", "dist/**"],
    });

    expect(config.test?.include).toEqual(["**/*.test.ts"]);
    expect(config.test?.exclude).toEqual(expect.arrayContaining(["channel/**", "dist/**"]));
  });
});

describe("scoped vitest configs", () => {
  it("defaults channel tests to non-isolated mode", async () => {
    const channelsConfig = await withEnvValue("OPENCLAW_VITEST_INCLUDE_FILE", undefined, async () =>
      importFreshConfig<{ default: { test?: { isolate?: boolean } } }>(
        "../vitest.channels.config.ts",
      ),
    );
    expect(channelsConfig.default.test?.isolate).toBe(false);
  });

  it("defaults extension tests to non-isolated mode", async () => {
    const extensionsConfig = await withEnvValue(
      "OPENCLAW_VITEST_INCLUDE_FILE",
      undefined,
      async () =>
        importFreshConfig<{ default: { test?: { isolate?: boolean } } }>(
          "../vitest.extensions.config.ts",
        ),
    );
    expect(extensionsConfig.default.test?.isolate).toBe(false);
  });

  it("normalizes extension include patterns relative to the scoped dir", async () => {
    const extensionsConfig = await withEnvValue(
      "OPENCLAW_VITEST_INCLUDE_FILE",
      undefined,
      async () =>
        importFreshConfig<{ default: { test?: { dir?: string; include?: string[] } } }>(
          "../vitest.extensions.config.ts",
        ),
    );
    expect(extensionsConfig.default.test?.dir).toBe("extensions");
    expect(extensionsConfig.default.test?.include).toEqual(["**/*.test.ts"]);
  });

  it("normalizes gateway include patterns relative to the scoped dir", async () => {
    const gatewayConfig = await withEnvValue("OPENCLAW_VITEST_INCLUDE_FILE", undefined, async () =>
      importFreshConfig<{ default: { test?: { dir?: string; include?: string[] } } }>(
        "../vitest.gateway.config.ts",
      ),
    );
    expect(gatewayConfig.default.test?.dir).toBe("src/gateway");
    expect(gatewayConfig.default.test?.include).toEqual(["**/*.test.ts"]);
  });
});
