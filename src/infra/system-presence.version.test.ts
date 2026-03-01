import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

async function withPresenceModule<T>(
  env: Record<string, string | undefined>,
  run: (module: typeof import("./system-presence.js")) => Promise<T> | T,
): Promise<T> {
  return withEnvAsync(env, async () => {
    vi.resetModules();
    try {
      const module = await import("./system-presence.js");
      return await run(module);
    } finally {
      vi.resetModules();
    }
  });
}

describe("system-presence version fallback", () => {
  it("prefers npm_package_version over OPENCLAW_SERVICE_VERSION when OPENCLAW_VERSION is not set", async () => {
    await withPresenceModule(
      {
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("1.0.0-package");
      },
    );
  });

  it("prefers OPENCLAW_VERSION over OPENCLAW_BUNDLED_VERSION and OPENCLAW_SERVICE_VERSION", async () => {
    await withPresenceModule(
      {
        OPENCLAW_VERSION: "9.9.9-cli",
        OPENCLAW_BUNDLED_VERSION: "8.8.8-bundled",
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("9.9.9-cli");
      },
    );
  });

  it("prefers OPENCLAW_BUNDLED_VERSION over OPENCLAW_SERVICE_VERSION when runtime version env is missing", async () => {
    await withPresenceModule(
      {
        OPENCLAW_VERSION: " ",
        OPENCLAW_BUNDLED_VERSION: "3.3.3-bundled",
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "\t",
      },
      ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("3.3.3-bundled");
      },
    );
  });

  it("uses npm_package_version when OPENCLAW_VERSION and OPENCLAW_SERVICE_VERSION are blank", async () => {
    await withPresenceModule(
      {
        OPENCLAW_VERSION: " ",
        OPENCLAW_BUNDLED_VERSION: " ",
        OPENCLAW_SERVICE_VERSION: "\t",
        npm_package_version: "1.0.0-package",
      },
      ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("1.0.0-package");
      },
    );
  });
});
