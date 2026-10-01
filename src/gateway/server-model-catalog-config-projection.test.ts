// Preserve provider fixtures before modules that consume them.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { getPreparedModelRuntimeAuthStore } from "../agents/prepared-model-runtime-auth.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import * as sourceProjection from "../config/source-value-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { buildGatewayReloadPlan, isNoopGatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.js";
import { prepareChatMetadataModelProjection } from "./server-methods/chat-metadata-session-projection.js";
import { modelsHandlers } from "./server-methods/models.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "./server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "./server-model-catalog.js";
import { createManagedReloadSecretHandlers } from "./server-reload-managed-secrets.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

const fixture = usePreparedModelRuntimeHarness({ label: "catalog-config-projection" }, async () => {
  await closePreparedModelRuntimeSnapshots();
  clearSecretsRuntimeSnapshot();
  vi.restoreAllMocks();
});
const prepareSecrets = (config: OpenClawConfig) =>
  prepareSecretsRuntimeSnapshot({ config, includeAuthStoreRefs: false, env: {} });

it.each([1, 32])(
  "prepares source routing once for %i rows after managed config publication",
  async (rowCount) => {
    const models: ModelCatalogEntry[] = Array.from({ length: rowCount }, (_, index) => ({
      provider: "openai",
      id: `fixture-${index}`,
      name: `Fixture ${index}`,
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
    }));
    const config: OpenClawConfig = {
      agents: {
        entries: { default: { workspace: fixture.state.workspaceDir } },
        defaults: {
          model: "openai/fixture-0",
          models: Object.fromEntries(models.map((model) => [`openai/${model.id}`, {}])),
          modelPolicy: { allow: ["openai/*"] },
        },
      },
      logging: { level: "info" },
    };
    fixture.mocks.configuredAgentIds = ["default"];
    fixture.mocks.configuredWorkspaces.set("default", fixture.state.workspaceDir);
    fixture.mocks.authStorage.getAll.mockReturnValue({
      openai: { type: "api_key", key: "synthetic-catalog-key" },
    });
    fixture.mocks.preparedAuthStore = {
      version: 1,
      profiles: {
        "openai:fixture": { type: "api_key", provider: "openai", key: "synthetic-catalog-key" },
      },
    };
    fixture.mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
      entries: models,
      routeVariants: models,
    });
    fixture.mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: models,
      routeVariants: models,
    });
    activateSecretsRuntimeSnapshotWithSource(await prepareSecrets(config), config);
    const getConfig = () => getRuntimeConfigSnapshot()!;
    await refreshPreparedModelRuntimeSnapshots(getConfig(), {
      gatewayLifecycle: true,
      catalogMode: "live",
      allowGatewaySubagentBinding: true,
    });
    const before = await prepareModelRuntimeSnapshot(fixture.agentInput("default", getConfig()));
    expect(before.config).toBe(getConfig());
    expect(before.modelCatalog.entries).toHaveLength(rowCount);
    await before.loadFullModelCatalog!({ refresh: true });
    const loader: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] = (params) =>
      loadGatewayModelCatalogSnapshot({ ...params, getConfig });
    registerGatewayModelCatalogPrivateAccess(loader, {
      loadDeferred: (params) => loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig }),
      readPrepared: (params) =>
        readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig }),
    });
    const context = createGatewayRequestContext(
      makeContextParams({ loadGatewayModelCatalogSnapshot: loader }),
    );
    const publishedBefore = await readPreparedGatewayModelCatalogOwnerSnapshot({
      agentId: "default",
      getConfig,
    });
    expect(publishedBefore?.entries).toHaveLength(rowCount);
    expect(publishedBefore?.agentId).toBe("default");
    const request = async () => {
      const params = { agentId: "default", view: "configured", includeDefaultModels: false };
      const respond = vi.fn();
      await modelsHandlers["models.list"]!({
        req: { type: "req", id: "catalog-projection", method: "models.list", params },
        params,
        respond,
        client: null,
        isWebchatConnect: () => false,
        context,
      });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls)).toBe(true);
      return respond.mock.calls[0]![1] as { models: unknown[] };
    };
    const initial = await request();
    expect(initial.models).toHaveLength(rowCount);
    const next: OpenClawConfig = { ...config, logging: { level: "debug" } };
    let preparedConfig: OpenClawConfig | undefined;
    const managed = createManagedReloadSecretHandlers({
      params: {
        activateRuntimeSecrets: createRuntimeSecretsActivator({
          logSecrets: { info() {}, warn() {}, error() {} },
          emitStateEvent() {},
          prepareRuntimeSecretsSnapshot: ({ config: candidate }) => prepareSecrets(candidate),
          activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
        }),
        resolveSharedGatewaySessionGenerationForConfig: () => undefined,
        sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
          current: undefined,
          required: null,
        }),
        clients: [],
        commitRuntimePolicy() {},
        async reconcileRuntimePolicy() {},
      },
      prepareRuntimeCandidate: (candidate) => candidate,
      tryPrepareRuntimeSecrets: async (candidate) => {
        const snapshot = await prepareSecrets(candidate);
        preparedConfig = snapshot.config;
        return { snapshot, expectedRevision: getActiveSecretsRuntimeSnapshotRevision() };
      },
      applyHotReload: async () => {
        throw new Error("Neutral config publication must not enter service reload");
      },
    });
    const ownership: GatewayConfigReloadTransactionOwnership = {
      isCurrent: () => true,
      checkpoint: async () => {},
      withRestartPreparation: async () => {
        throw new Error("Unexpected restart");
      },
      markRuntimeCommitted() {},
      commitRuntimeEnv() {},
      publishRuntimeEnv() {},
      rollbackRuntimeEnv() {},
      reapplyRuntimeOverlays: (candidate) => candidate,
    };
    const plan = buildGatewayReloadPlan(["logging.level"], { candidateConfig: next });
    expect(isNoopGatewayReloadPlan(plan)).toBe(true);
    await managed.onHotReload(plan, next, ownership, next);
    const owner = await prepareModelRuntimeSnapshot(fixture.agentInput("default", getConfig()));
    expect(owner.config).toBe(preparedConfig);
    expect(owner.config).not.toBe(getConfig());
    expect(owner.config).toEqual(getConfig());
    expect(owner.observationConfig).toBe(before.observationConfig);
    expect(getRuntimeConfigSourceSnapshot()).toBe(next);
    expect(owner.isCurrent()).toBe(true);

    const projection = vi.spyOn(sourceProjection, "projectRuntimeChangesOntoSource");
    const after = await request();
    expect(after).toEqual(initial);
    expect(projection.mock.calls.length).toBeLessThanOrEqual(1);
    projection.mockClear();
    const authStore = getPreparedModelRuntimeAuthStore(owner)!;
    const metadata = await prepareChatMetadataModelProjection({
      context,
      facts: {
        agentId: "default",
        owner,
        authStore,
        authModes: owner.authModes,
        modelCatalog: owner.modelCatalog,
      },
    });
    expect(metadata.isCurrent()).toBe(true);
    expect(projection.mock.calls.length).toBeLessThanOrEqual(1);
    projection.mockClear();
    const firstRead = metadata.read();
    expect(firstRead.models).toHaveLength(rowCount);
    expect(metadata.read()).toEqual(firstRead);
    expect(projection).not.toHaveBeenCalled();
    expect(owner.config).toBe(preparedConfig);
    expect(owner.observationConfig).toBe(before.observationConfig);
    expect(getRuntimeConfigSourceSnapshot()).toBe(next);
    expect(owner.isCurrent()).toBe(true);
    await closePreparedModelRuntimeSnapshots();
    expect(metadata.isCurrent()).toBe(false);
  },
);
