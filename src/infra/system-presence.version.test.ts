import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

async function withPresenceModule<T>(
  env: Record<string, string | undefined>,
  run: (module: typeof import("./system-presence.js")) => Promise<T> | T,
): Promise<T> {
  return withEnvAsync(env, async () => {
    vi.resetModules();
    const module = await import("./system-presence.js");
    return await run(module);
  });
}

async function expectedRuntimeVersion(env: Record<string, string | undefined>): Promise<string> {
  const { resolveRuntimeServiceVersion } = await import("../version.js");
  return resolveRuntimeServiceVersion(env);
}

describe("system-presence version fallback", () => {
  it("uses runtime service version resolution when OPENCLAW_VERSION is not set", async () => {
    const env = {
      OPENCLAW_BUNDLED_VERSION: "7.7.7-runtime",
      OPENCLAW_SERVICE_VERSION: "2.4.6-service",
      npm_package_version: "1.0.0-package",
    };

    await withPresenceModule(env, async ({ listSystemPresence }) => {
      const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
      expect(selfEntry?.version).toBe(await expectedRuntimeVersion(env));
    });
  });

  it("uses runtime service version resolution when OPENCLAW_VERSION is set", async () => {
    const env = {
      OPENCLAW_BUNDLED_VERSION: "7.7.7-runtime",
      OPENCLAW_VERSION: "9.9.9-cli",
      OPENCLAW_SERVICE_VERSION: "2.4.6-service",
      npm_package_version: "1.0.0-package",
    };

    await withPresenceModule(env, async ({ listSystemPresence }) => {
      const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
      expect(selfEntry?.version).toBe(await expectedRuntimeVersion(env));
    });
  });

  it("uses runtime service version resolution when OPENCLAW_VERSION and OPENCLAW_SERVICE_VERSION are blank", async () => {
    const env = {
      OPENCLAW_BUNDLED_VERSION: "7.7.7-runtime",
      OPENCLAW_VERSION: " ",
      OPENCLAW_SERVICE_VERSION: "\t",
      npm_package_version: "1.0.0-package",
    };

    await withPresenceModule(env, async ({ listSystemPresence }) => {
      const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
      expect(selfEntry?.version).toBe(await expectedRuntimeVersion(env));
    });
  });
});
