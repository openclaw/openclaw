import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createProvisionVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/gemmaclaw/**/*.test.ts"], {
    dir: "src/gemmaclaw",
    env,
    name: "provision",
  });
}

export default createProvisionVitestConfig();
