import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayClientVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    [
      "packages/gateway-client/src/**/*.test.ts",
      "packages/gateway-protocol/src/**/*.test.ts",
      "src/gateway/**/*client*.test.ts",
      "src/gateway/**/*reconnect*.test.ts",
      "src/gateway/**/*android-node*.test.ts",
      "src/gateway/**/*gateway-cli-backend*.test.ts",
    ],
    {
      env,
      exclude: ["src/gateway/**/*server*.test.ts"],
      // This shard mixes fake-timer client unit tests, module-level mocks, and
      // loopback WebSocket connection tests. Keep files isolated so timer/mock
      // state cannot leak into another file's real connection readiness wait.
      isolate: true,
      name: "gateway-client",
    },
  );
}

export default createGatewayClientVitestConfig();
