import { describe, expect, it, vi } from "vitest";

const VERSION_ENV_KEYS = [
  "OPENCLAW_VERSION",
  "OPENCLAW_SERVICE_VERSION",
  "npm_package_version",
] as const;

type VersionEnvKey = (typeof VERSION_ENV_KEYS)[number];
type VersionEnv = Partial<Record<VersionEnvKey, string | undefined>>;

async function withPresenceModule<T>(
  env: VersionEnv,
  run: (module: typeof import("./system-presence.js")) => Promise<T> | T,
): Promise<T> {
  const previous = Object.fromEntries(
    VERSION_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<VersionEnvKey, string | undefined>;

  for (const key of VERSION_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  try {
    const module = await import("./system-presence.js");
    return await run(module);
  } finally {
    for (const key of VERSION_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  }
}

describe("system-presence version fallback", () => {
  it("uses OPENCLAW_SERVICE_VERSION when OPENCLAW_VERSION is not set", async () => {
    await withPresenceModule(
      {
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("2.4.6-service");
      },
    );
  });

  it("prefers OPENCLAW_VERSION over OPENCLAW_SERVICE_VERSION", async () => {
    await withPresenceModule(
      {
        OPENCLAW_VERSION: "9.9.9-cli",
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("9.9.9-cli");
      },
    );
  });
});
