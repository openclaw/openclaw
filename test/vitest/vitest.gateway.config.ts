import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/gateway/**/*.test.ts"], {
    dir: "src/gateway",
    env,
    exclude: [
      "src/gateway/gateway.test.ts",
      "src/gateway/server.startup-matrix-migration.integration.test.ts",
      "src/gateway/sessions-history-http.test.ts",
    ],
    name: "gateway",
  });
}

export default createGatewayVitestConfig();
