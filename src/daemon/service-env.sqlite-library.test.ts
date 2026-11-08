import { describe, expect, it } from "vitest";
import { buildNodeServiceEnvironment, buildServiceEnvironment } from "./service-env.js";

describe("managed service SQLite library environment", () => {
  const sqliteEnv = {
    HOME: "/Users/testuser",
    OPENCLAW_SQLITE_LIBRARY: " /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib ",
    HOMEBREW_PREFIX: " /opt/homebrew ",
  };
  const expectedSqliteEnv = {
    OPENCLAW_SQLITE_LIBRARY: "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    HOMEBREW_PREFIX: "/opt/homebrew",
  };

  it.each([
    ["darwin", "bun", undefined, true],
    ["darwin", "node", undefined, false],
    ["linux", "bun", undefined, false],
    ["win32", "bun", undefined, false],
    ["darwin", "node", " /usr/local/bin/openclaw-wrapper ", true],
    ["darwin", "node", "   ", false],
  ] as const)(
    "forwards gateway SQLite inputs on %s with runtime %s and wrapper %s: %s",
    (platform, runtime, wrapper, forwards) => {
      const env = buildServiceEnvironment({
        env: { ...sqliteEnv, OPENCLAW_WRAPPER: wrapper },
        port: 18789,
        platform,
        runtime,
      });

      if (forwards) {
        expect(env).toMatchObject(expectedSqliteEnv);
      } else {
        expect(env).not.toHaveProperty("OPENCLAW_SQLITE_LIBRARY");
        expect(env).not.toHaveProperty("HOMEBREW_PREFIX");
      }
    },
  );

  it("omits blank overrides and relative Homebrew prefixes for macOS Bun services", () => {
    const env = buildServiceEnvironment({
      env: { ...sqliteEnv, OPENCLAW_SQLITE_LIBRARY: "   ", HOMEBREW_PREFIX: " opt/homebrew " },
      port: 18789,
      platform: "darwin",
      runtime: "bun",
    });

    expect(env).not.toHaveProperty("OPENCLAW_SQLITE_LIBRARY");
    expect(env).not.toHaveProperty("HOMEBREW_PREFIX");
  });

  it.each(["bun", undefined] as const)(
    "forwards macOS node-host SQLite inputs only with Bun selected (runtime: %s)",
    (runtime) => {
      const env = buildNodeServiceEnvironment({ env: sqliteEnv, platform: "darwin", runtime });

      if (runtime === "bun") {
        expect(env).toMatchObject(expectedSqliteEnv);
      } else {
        expect(env).not.toHaveProperty("OPENCLAW_SQLITE_LIBRARY");
        expect(env).not.toHaveProperty("HOMEBREW_PREFIX");
      }
    },
  );
});
