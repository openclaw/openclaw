import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayServerVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/gateway/**/*server*.test.ts"], {
    dir: "src/gateway",
    env,
    exclude: [
      "src/gateway/server-methods/**/*.test.ts",
      "src/gateway/gateway.test.ts",
      "src/gateway/server.startup-matrix-migration.integration.test.ts",
      "src/gateway/sessions-history-http.test.ts",
    ],
    name: "gateway-server",
  });
}

export default createGatewayServerVitestConfig();
