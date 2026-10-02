import { expect, it, type Mock } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { LoadPreparedModelCatalogParams } from "../agents/prepared-model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import type { TuiModelChoice } from "./tui-backend.js";

export function registerEmbeddedModelCatalogTests({
  createBackend,
  getRuntimeConfigMock,
  loadPreparedModelCatalogMock,
  buildModelsListResultMock,
  withPreparedModelCatalogOwnerMock,
  projectSessionsPatchEntryMock,
  applySessionPatchProjectionMock,
  deferred,
  flushMicrotasks,
}: {
  createBackend: () => EmbeddedTuiBackend;
  getRuntimeConfigMock: Mock<() => object>;
  loadPreparedModelCatalogMock: Mock<
    (_params?: LoadPreparedModelCatalogParams) => ModelCatalogEntry[]
  >;
  buildModelsListResultMock: Mock<
    (params: Parameters<typeof buildModelsListResult>[0]) => Promise<{ models: TuiModelChoice[] }>
  >;
  withPreparedModelCatalogOwnerMock: unknown;
  projectSessionsPatchEntryMock: Mock;
  applySessionPatchProjectionMock: unknown;
  deferred: <T>() => {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error?: unknown) => void;
  };
  flushMicrotasks: () => Promise<void>;
}) {
  it("lists the published configured replace-mode models without a second catalog read", async () => {
    const config = {
      models: {
        mode: "replace" as const,
        providers: {
          fixture: {
            baseUrl: "https://fixture.invalid",
            models: [{ id: "configured", name: "Configured" }],
          },
        },
      },
    };
    getRuntimeConfigMock.mockReturnValue(config);
    const models = [{ id: "configured", name: "Configured", provider: "fixture", available: true }];
    buildModelsListResultMock.mockResolvedValue({ models });

    await expect(createBackend().listModels()).resolves.toEqual(models);
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
    expect(withPreparedModelCatalogOwnerMock).toHaveBeenCalledWith(
      { config, agentId: "main", readOnly: true },
      expect.any(Function),
    );
  });

  it("preserves an empty published replace catalog without fallback discovery", async () => {
    getRuntimeConfigMock.mockReturnValue({ models: { mode: "replace", providers: {} } });
    await expect(createBackend().listModels()).resolves.toEqual([]);
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
    expect(buildModelsListResultMock).toHaveBeenCalledOnce();
  });

  it("lists published discovered rows for a replace-mode provider wildcard", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: { defaults: { modelPolicy: { allow: ["fixture/*"] } } },
      models: { mode: "replace", providers: { fixture: { models: [{ id: "configured" }] } } },
    });
    const models = [{ id: "discovered", name: "Discovered", provider: "fixture" }];
    buildModelsListResultMock.mockResolvedValue({ models });
    await expect(createBackend().listModels()).resolves.toEqual(models);
    expect(withPreparedModelCatalogOwnerMock).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
      expect.any(Function),
    );
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
  });

  it("loads the selected agent published projection with its matching owner", async () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { modelPolicy: { allow: ["fixture/main-model"] } },
          work: { modelPolicy: { allow: ["fixture/work-model"] } },
        },
      },
    };
    getRuntimeConfigMock.mockReturnValue(config);
    buildModelsListResultMock.mockImplementation(async ({ source, agentId, params }) => {
      expect(source.kind).toBe("published");
      if (source.kind !== "published") {
        throw new Error("Expected published owner");
      }
      expect(source.owner.agentId).toBe(agentId);
      expect(source.owner.config).toBe(config);
      expect(params).toEqual({ includeDetails: true });
      const id = source.owner.agentId + "-model";
      return { models: [{ id, name: id, provider: "fixture" }] };
    });
    await expect(createBackend().listModels({ agentId: "work" })).resolves.toEqual([
      { id: "work-model", name: "work-model", provider: "fixture" },
    ]);
  });

  it("preserves an empty restrictive published projection for the selected agent", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        entries: {
          main: { modelPolicy: { allow: ["openai/*"] } },
          work: { modelPolicy: { allow: ["openai/*"] } },
        },
      },
    });
    await expect(createBackend().listModels({ agentId: "work" })).resolves.toEqual([]);
    expect(buildModelsListResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work" }),
    );
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
  });

  it("preserves canonical unavailable and unknown published model facts", async () => {
    const models: TuiModelChoice[] = [
      {
        id: "waiting",
        name: "Waiting",
        provider: "fixture",
        available: false,
        unavailableReason: "cooldown",
      },
      { id: "unknown", name: "Unknown", provider: "fixture" },
    ];
    buildModelsListResultMock.mockResolvedValue({ models });
    await expect(createBackend().listModels()).resolves.toEqual(models);
    expect(loadPreparedModelCatalogMock).not.toHaveBeenCalled();
  });

  it("keeps the published owner alive through asynchronous model projection", async () => {
    const projection = deferred<{ models: TuiModelChoice[] }>();
    let current: (() => boolean) | undefined;
    buildModelsListResultMock.mockImplementation(async ({ source }) => {
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
    getRuntimeConfigMock.mockReturnValue(config);
    const catalog: ModelCatalogEntry[] = [
      { id: "discovered", name: "Discovered", provider: "fixture", api: "openai-completions" },
    ];
    loadPreparedModelCatalogMock.mockReturnValue(catalog);
    const models = [{ id: "discovered", name: "Discovered", provider: "fixture", available: true }];
    buildModelsListResultMock.mockResolvedValue({ models });
    projectSessionsPatchEntryMock.mockImplementation(
      async ({
        loadGatewayModelCatalogSnapshot,
      }: {
        loadGatewayModelCatalogSnapshot: () => Promise<{
          entries: unknown[];
          routeVariants: unknown[];
        }>;
      }) => {
        expect(await loadGatewayModelCatalogSnapshot()).toEqual({
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
    expect(loadPreparedModelCatalogMock).toHaveBeenCalledWith({
      config,
      agentId: "main",
      readOnly: true,
    });
    expect(applySessionPatchProjectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKeys: ["agent:main:main"] }),
    );
  });
}

export async function withEmbeddedModelCatalogOwnerFixture(
  params: LoadPreparedModelCatalogParams,
  read: (snapshot: PreparedModelRuntimeSnapshot) => Promise<unknown>,
) {
  const config: OpenClawConfig = params.config ?? {};
  const agentId = params.agentId ?? "main";
  let active = true;
  const snapshot: PreparedModelRuntimeSnapshot = {
    catalogOwner: { agentId, workspaceDir: "/tmp/tui-catalog-workspace" },
    agentId,
    agentDir: "/tmp/tui-catalog-agent",
    activeProjectKeys: [],
    config,
    observationConfig: config,
    isCurrent: () => active,
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores() {
      throw new Error("Catalog projection must not create execution stores");
    },
  };
  bindPreparedModelRuntimeAuth(snapshot, { store: { version: 1, profiles: {} } });
  try {
    return await read(snapshot);
  } finally {
    active = false;
  }
}
