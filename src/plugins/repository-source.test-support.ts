import { onTestFinished } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import type { RepositorySourceV1 } from "./repository-source-types.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

export function createRepositorySourceFixture(source: RepositorySourceV1) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "repository-example",
    source: "/synthetic/repository-example.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    repositorySources: [{ id: source.id, label: "Example", searchMethod: "example.search" }],
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record)!;
  onTestFinished(async () => {
    await instance.dispose();
  });
  api.registerRepositorySource(source);
  return {
    registry: builder.registry,
    api,
    instance,
    id: `repository-example/${source.id}`,
    run<T>(operation: () => T) {
      return withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: builder.registry, isWebchatConnect: () => false },
        operation,
      );
    },
  };
}
