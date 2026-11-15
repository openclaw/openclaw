// Vitest cron config wires the cron test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCronVitestConfig(
  env?: Record<string, string | undefined>,
): ReturnType<typeof createScopedVitestConfig> {
  const config = createScopedVitestConfig(["src/cron/**/*.test.ts"], {
    dir: "src",
    env,
    intersectIncludeFile: true,
    name: "cron",
    pool: "forks",
    passWithNoTests: true,
  });
  return {
    ...config,
    test: {
      ...config.test,
      // Native SQLite workers compare hrtime deadlines with this host. Only
      // scheduling clocks may advance independently of those worker deadlines.
      fakeTimers: {
        toFake: [
          "Date",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "setImmediate",
          "clearImmediate",
          "performance",
        ],
      },
    },
  };
}

export default createCronVitestConfig();
