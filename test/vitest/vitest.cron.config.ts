// Vitest cron config wires the cron test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCronVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/cron/**/*.test.ts"], {
    dir: "src",
    env,
    name: "cron",
    pool: "forks",
    passWithNoTests: true,
  });
}

export default createCronVitestConfig();
