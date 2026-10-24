import { expect, it, type Mock } from "vitest";
import { createEmptyPreparedModelRuntimeFixture } from "../agents/embedded-agent-runner/model.fixture.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { LoadPreparedModelCatalogParams as CatalogParams } from "../agents/prepared-model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import type { deferred as createDeferred } from "./embedded-backend.test-helpers.js";
import type { TuiModelChoice } from "./tui-backend.js";

const model = (name: string, details: Partial<TuiModelChoice> = {}): TuiModelChoice => ({
  id: name.toLowerCase(),
  name,
  provider: "fixture",
  ...details,
});

export function registerEmbeddedModelCatalogTests({
  createBackend,
  getRuntimeConfigMock: configMock,
  loadPreparedModelCatalogMock: catalogMock,
  buildModelsListResultMock: project,
  withPreparedModelCatalogOwnerMock: withOwner,
  projectSessionsPatchEntryMock: patch,
  applySessionPatchProjectionMock: applyPatch,
  deferred,
  flushMicrotasks,
}: {
  createBackend: () => EmbeddedTuiBackend;
  getRuntimeConfigMock: Mock<() => object>;
  loadPreparedModelCatalogMock: Mock<(_params?: CatalogParams) => ModelCatalogEntry[]>;
  buildModelsListResultMock: Mock<
    (params: Parameters<typeof buildModelsListResult>[0]) => Promise<{ models: TuiModelChoice[] }>
  >;
  withPreparedModelCatalogOwnerMock: unknown;
  projectSessionsPatchEntryMock: Mock;
  applySessionPatchProjectionMock: unknown;
  deferred: typeof createDeferred;
  flushMicrotasks: () => Promise<void>;
}) {
  it.each([undefined, "work"])("lists %s without rediscovery", async (agentId) => {
    const ownerId = agentId ?? "main";
    const config: OpenClawConfig = { models: { mode: "replace" } };
    const models = agentId
      ? []
      : [
          model("Configured", { available: true }),
          model("Waiting", { available: false, unavailableReason: "cooldown" }),
          model("Unknown"),
        ];
    configMock.mockReturnValue(config);
    project.mockImplementation(async ({ source, agentId: owner, params }) => {
      if (source.kind !== "published") {
        throw new Error("Expected published owner");
      }
      expect(source.owner.config).toBe(config);
      expect([owner, source.owner.agentId]).toEqual([ownerId, ownerId]);
      expect(params).toEqual({ includeDetails: true });
      return { models };
    });
    await expect(createBackend().listModels(agentId ? { agentId } : undefined)).resolves.toEqual(
      models,
    );
    expect(project).toHaveBeenCalledOnce();
    expect(withOwner).toHaveBeenCalledWith(
      { config, agentId: ownerId, readOnly: true },
      expect.any(Function),
    );
    expect(catalogMock).not.toHaveBeenCalled();
  });

  it("keeps the published owner alive through asynchronous model projection", async () => {
    const projection = deferred<{ models: TuiModelChoice[] }>();
    let current: (() => boolean) | undefined;
    project.mockImplementation(async ({ source }) => {
      if (source.kind !== "published") {
        throw new Error("Expected published owner");
      }
      current = source.owner.isCurrent;
      expect(current()).toBe(true);
      const result = await projection.promise;
      expect(current()).toBe(true);
      return result;
    });
    const pending = createBackend().listModels();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(current?.()).toBe(true);
    projection.resolve({ models: [] });
    await expect(pending).resolves.toEqual([]);
    expect(current?.()).toBe(false);
  });

  it("patches wildcard replace-mode sessions with raw execution catalog entries", async () => {
    const config = {
      agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } } },
      models: { mode: "replace" },
    };
    configMock.mockReturnValue(config);
    const discovered = model("Discovered");
    const catalog: ModelCatalogEntry[] = [{ ...discovered, api: "openai-completions" }];
    catalogMock.mockReturnValue(catalog);
    const models = [{ ...discovered, available: true }];
    project.mockResolvedValue({ models });
    patch.mockImplementation(
      async (params: { loadGatewayModelCatalogSnapshot: () => Promise<ModelCatalogSnapshot> }) => {
        expect(await params.loadGatewayModelCatalogSnapshot()).toEqual({
          entries: catalog,
          routeVariants: catalog,
        });
        return { ok: true, entry: {} };
      },
    );
    const backend = createBackend();
    await expect(backend.listModels()).resolves.toEqual(models);
    await expect(
      backend.patchSession({ key: "agent:main:main", model: "fixture/discovered" }),
    ).resolves.toMatchObject({ ok: true, key: "agent:main:main" });
    expect(catalogMock).toHaveBeenCalledWith({ config, agentId: "main", readOnly: true });
    expect(applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKeys: ["agent:main:main"] }),
    );
  });
}

export async function withEmbeddedModelCatalogOwnerFixture(
  params: CatalogParams,
  read: (snapshot: PreparedModelRuntimeSnapshot) => Promise<unknown>,
) {
  const config: OpenClawConfig = params.config ?? {};
  const agentId = params.agentId ?? "main";
  let active = true;
  const snapshot: PreparedModelRuntimeSnapshot = {
    ...createEmptyPreparedModelRuntimeFixture({
      agentDir: "/tmp/tui-catalog-agent",
      config,
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      createStores() {
        throw new Error("Catalog projection must not create execution stores");
      },
    }),
    catalogOwner: { agentId, workspaceDir: "/tmp/tui-catalog-workspace" },
    agentId,
    isCurrent: () => active,
  };
  bindPreparedModelRuntimeAuth(snapshot, { store: { version: 1, profiles: {} } });
  try {
    return await read(snapshot);
  } finally {
    active = false;
  }
}
