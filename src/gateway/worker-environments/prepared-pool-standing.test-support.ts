import { vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createPreparationArtifacts,
  RECEIPT,
  type usePreparedPoolFixture,
} from "./prepared-pool.test-support.js";
import { createWorkerEnvironmentService } from "./service.js";
import { NODE_BOOTSTRAP, type WorkerEnvironmentServiceOptions } from "./service.test-support.js";

export function installStandingPolicy(
  config: OpenClawConfig,
  builder = createTestPluginRegistry(),
) {
  const previous = builder.registry.plugins.find((record) => record.id === "standing-policy");
  const disposal = previous && getPluginInstance(previous)?.dispose();
  if (previous) {
    builder.registry.plugins = builder.registry.plugins.filter((record) => record !== previous);
    builder.registry.repositoryIntegrations = builder.registry.repositoryIntegrations.filter(
      (entry) => entry.pluginId !== previous.id,
    );
  }
  const record = createPluginRecord({
    id: "standing-policy",
    source: "synthetic-policy",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  record.contracts = { repositoryIntegrations: ["repository"] };
  builder.registry.plugins.push(record);
  const credentials = vi.fn(async () => {
    throw new Error("Image reserves must not obtain repository credentials");
  });
  builder.createApi(record, { config }).registerRepositoryIntegration({
    version: 1,
    preparedCapacity: "image",
    resolveConnectionIdentity: () => undefined,
    withIdentity: credentials,
  });
  config.gateway = { repositoryIntegration: record.id };
  setRuntimeConfigSnapshot(config);
  setActivePluginRegistry(builder.registry);
  return { record, instance: getPluginInstance(record)!, credentials, disposal };
}

export function createStandingService(
  f: ReturnType<typeof usePreparedPoolFixture>,
  overrides: Partial<WorkerEnvironmentServiceOptions> = {},
) {
  const artifacts = createPreparationArtifacts();
  f.service = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    logger: { warn: () => {} },
    store: f.store,
    getConfig: () => f.config,
    resolveProvider: () => f.provider,
    projectNamespace: "standing-lifecycle-proof",
    prepareInstallation: async () => ({
      ...RECEIPT,
      install: "bundle",
      tarballPath: "/synthetic/bundle.tgz",
      tarballBytes: 1,
      tarballSha256: artifacts.workerArchiveSha256,
    }),
    bootstrapWorker: async () => RECEIPT,
    prepareNodeArtifacts: async () => {
      return { artifacts, assertCurrent: () => {} };
    },
    prepareNodeBootstrap: async () => artifacts.nodeBootstrapSha256,
    prepareNodeEnrollment: async (record) => {
      const pending = await f.store.ensureNodeEnrollment(record.environmentId);
      return {
        mode: "connect",
        setupId: pending.nodeSetupId!,
        setupCode: "synthetic-setup",
        displayName: "Standing reserve",
        openclawVersion: artifacts.openclawVersion,
        nodeBootstrap: {
          ...NODE_BOOTSTRAP,
          sha256: artifacts.nodeBootstrapSha256,
          enabledPluginIds: [],
          openclawVersion: artifacts.openclawVersion,
        },
        waitForDeviceId: async () => "node:" + record.provisionOperationId,
      };
    },
    ensureNodeWorkerBundle: async () => RECEIPT,
    resolveHumanPresenceDemand: () => ({
      profileId: "development",
      executionMode: "worker-turn",
      repository: { agentId: "main", url: "https://github.com/acme/private-repo.git" },
    }),
    now: () => f.nowMs,
    ...overrides,
  });
  return f.service;
}
