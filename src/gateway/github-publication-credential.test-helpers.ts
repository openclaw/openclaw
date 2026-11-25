import { setRuntimeConfigSnapshot } from "../config/config.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import type { RepositoryIntegration } from "../plugins/repository-integration.types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { createRequesterPolicyFixture } from "./github-publication-requester.test-support.js";

export function registerAppCredentialFixture(
  f: Pick<Awaited<ReturnType<typeof createRequesterPolicyFixture>>, "config">,
  inspectAdmission?: Parameters<typeof registerPublicationCredentialFixture>[2],
) {
  f.config.tools = {
    ...f.config.tools,
    github: {
      kind: "app-installation",
      profileId: "ghp_11111111111111111111111111111111",
      app: {
        appId: 101,
        installationId: 202,
        accountId: 42,
        repositories: [{ id: 10, fullName: "openclaw/openclaw" }],
        permissions: { contents: "write", pull_requests: "write" },
        privateKey: "synthetic-unread-private-key",
        keyVersion: "synthetic-v1",
      },
    },
  };
  registerPublicationCredentialFixture(f, [], inspectAdmission);
}

// Shared synthetic credential provider; native context/profile authority remains authoritative.
export function registerPublicationCredentialFixture(
  f: Pick<Awaited<ReturnType<typeof createRequesterPolicyFixture>>, "config">,
  events: string[],
  inspectAdmission?: (context: Parameters<RepositoryIntegration["withIdentity"]>[0]) => void,
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
      inspectAdmission?.(context);
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
