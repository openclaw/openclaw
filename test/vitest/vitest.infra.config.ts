import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createInfraVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/infra/**/*.test.ts"], {
    dir: "src",
    env,
    name: "infra",
    passWithNoTests: true,
  });
}

export default createInfraVitestConfig();
