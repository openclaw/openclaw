import { setRuntimeConfigSnapshot } from "../config/config.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { createRequesterPolicyFixture } from "./github-publication-requester.test-support.js";

// Shared synthetic credential provider; native context/profile authority remains authoritative.
export function registerPublicationCredentialFixture(
  f: Awaited<ReturnType<typeof createRequesterPolicyFixture>>,
  events: string[],
) {
  const synthetic = "local-synthetic-no-provider-authority";
  f.config.gateway!.repositoryIntegration = "publication-local-sink";
  setRuntimeConfigSnapshot(f.config);
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "publication-local-sink",
    name: "publication-local-sink",
    source: "local-proof",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  record.contracts = { repositoryIntegrations: ["repository"] };
  builder.registry.plugins.push(record);
  builder.createApi(record, { config: f.config }).registerRepositoryIntegration({
    version: 1,
    preparedCapacity: "repository",
    resolveConnectionIdentity: () => undefined,
    async withIdentity(context, run) {
      context.assertCurrent();
      context.readCurrentProfile();
      events.push("integration-admitted");
      return await run({
        env: context.env,
        assertCurrent: context.assertCurrent,
        readNativeCredential: async () => {
          context.assertCurrent();
          events.push("credential");
          return synthetic;
        },
      });
    },
  });
  setActivePluginRegistry(builder.registry);
  return synthetic;
}
