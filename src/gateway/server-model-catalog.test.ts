import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import {
  preparePublishedModelCatalogOwnerIdentity,
  resolvePublishedModelCatalogOwner,
} from "../agents/prepared-model-catalog-owner.js";
import type { PublishedModelCatalogOwnerCandidate } from "../agents/prepared-model-catalog.types.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as currentPluginMetadata from "../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  loadDeferredCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "./server-model-catalog-auth.js";
import {
  createPreparedGatewayModelCatalog,
  readPreparedGatewayModelMetadata,
} from "./server-model-catalog-view.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  type GatewayModelCatalogSnapshot,
} from "./server-model-catalog.js";
import { readSessionRowModelFacts } from "./session-row-model-facts.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const agentDir = "/tmp/gateway-agent";
const workspaceDir = "/tmp/gateway-workspace";
const snapshot: ModelCatalogSnapshot = {
  entries: [{ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" }],
  routeVariants: [],
};

function ownerConfig(agentId = "main", extra: OpenClawConfig = {}): OpenClawConfig {
  return {
    ...extra,
    agents: {
      ...extra.agents,
      entries: {
        [agentId]: { agentDir, workspace: workspaceDir },
      },
    },
  };
}

function ownerSnapshot(
  config: OpenClawConfig,
  modelCatalog: ModelCatalogSnapshot = snapshot,
  agentId?: string,
): PublishedModelCatalogOwnerCandidate {
  return {
    catalogOwner: preparePublishedModelCatalogOwnerIdentity({ config, agentId, agentDir }),
    ...(agentId ? { agentId } : {}),
    agentDir,
    config,
    observationConfig: config,
    isCurrent: () => true,
    authModes: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
    modelCatalog,
  };
}

function catalogLoaders(candidate: PublishedModelCatalogOwnerCandidate) {
  const params = {
    getConfig: () => candidate.config,
    loadPublishedPreparedModelCatalogOwnerSnapshot: vi.fn(async () => candidate),
  };
  const publicLoader = vi.fn(() => loadGatewayModelCatalogSnapshot(params));
  registerGatewayModelCatalogPrivateAccess(publicLoader, {
    loadDeferred: (options) => loadPreparedGatewayModelCatalogSnapshot({ ...params, ...options }),
    readPrepared: async () => undefined,
  });
  return { params, publicLoader };
}

describe("gateway prepared model catalog", () => {
  it("keeps a prepared metadata miss separate from the current runtime generation", async () => {
    const capturedMetadata = createPluginMetadataSnapshotFixture();
    const currentMetadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "ambient-provider",
          providers: ["custom"],
          cliBackends: ["catalog-generation-cli"],
          modelIdNormalization: { providers: { custom: { aliases: { latest: "foreign" } } } },
        },
      ],
    });
    const absent = createPreparedGatewayModelCatalog({ entries: [] });
    const present = createPreparedGatewayModelCatalog({
      entries: [],
      metadataSnapshot: capturedMetadata,
    });
    const current = createPreparedGatewayModelCatalog({
      entries: [],
      metadataSnapshot: currentMetadata,
    });
    withPluginRuntimeGenerationScope({ metadataSnapshot: currentMetadata }, () => {
      expect(readPreparedGatewayModelMetadata({})).toBe(currentMetadata);
      expect(readPreparedGatewayModelMetadata({}, absent)).toBeNull();
      expect(readPreparedGatewayModelMetadata({}, present)).toBe(capturedMetadata);
      const entry = {
        sessionId: "prepared-catalog",
        updatedAt: 1,
        providerOverride: "custom",
        modelOverride: "latest",
      };
      const facts = readSessionRowModelFacts({
        cfg: ownerConfig(),
        key: "agent:main:prepared-catalog",
        agentId: "main",
        entry,
        source: { entry, readSourceEntry: () => undefined },
        rowContext: buildSessionListRowMetadataContext({ now: 1 }),
        preparedModelMetadata: currentMetadata,
        modelCatalog: new Map([["main", absent]]),
        lightweightListRow: true,
      });
      expect(facts.selectedModel).toMatchObject({ provider: "custom", model: "latest" });
      const cliEntry = {
        ...entry,
        providerOverride: "catalog-generation-cli",
        modelOverride: "custom/shared-model",
        modelOverrideRouteResolution: "resolved" as const,
      };
      const rowContext = buildSessionListRowMetadataContext({ now: 1 });
      for (const catalog of [absent, current, absent]) {
        const cliFacts = readSessionRowModelFacts({
          cfg: ownerConfig(),
          key: "agent:main:prepared-cli",
          agentId: "main",
          entry: cliEntry,
          source: { entry: cliEntry, readSourceEntry: () => undefined },
          rowContext,
          modelCatalog: new Map([["main", catalog]]),
          lightweightListRow: true,
        });
        expect(cliFacts.rowModelIdentity).toEqual(
          catalog === absent
            ? { provider: "catalog-generation-cli", model: "custom/shared-model" }
            : { provider: "custom", model: "shared-model" },
        );
      }
    });
    const cfg = ownerConfig("main", {
      agents: { defaults: { model: "custom/latest" } },
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: {
              agents: ["main"],
              scopes: ["operator.read"],
              sessions: { others: "view" },
              modelPolicy: { sourceAgent: "main", allow: ["custom/*"] },
            },
          },
        },
      },
    });
    const client: GatewayClient = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.read"],
      },
      internal: { operatorRoleActor: { kind: "operator", profileId: "reader" } },
      preparedSessionProfile: { profileId: "reader", aliases: new Set(["reader"]), role: null },
    };
    const ambient = vi
      .spyOn(currentPluginMetadata, "getGatewayPluginMetadataSnapshot")
      .mockReturnValue(currentMetadata);
    try {
      for (const [catalog, model] of [
        [absent, "latest"],
        [current, "foreign"],
      ] as const) {
        const projection = createSessionRowProjectionFixture({
          cfg,
          store: {},
          modelCatalog: new Map([["main", catalog]]),
        });
        try {
          const result = await listProjectedSessions({
            projection,
            client,
            opts: { agentId: "main" },
          });
          expect(result.defaults).toMatchObject({ modelProvider: "custom", model });
        } finally {
          projection.dispose();
        }
      }
    } finally {
      ambient.mockRestore();
    }
  });

  it.each([
    ["wrong directory", "main", "/tmp/wrong-agent", "unique", false],
    ["unknown explicit id", "missing", agentDir, "unique", false],
    ["explicit empty roster", "main", agentDir, "empty", false],
    ["shared directory without id", undefined, agentDir, "shared", false],
    ["explicit shared-directory id", "WORKER", agentDir, "shared", true],
    ["unique directory without id", undefined, agentDir, "unique", true],
  ] as const)(
    "preserves prepared binding validation: %s",
    async (_name, agentId, requestedDir, roster, bound) => {
      const config = ownerConfig();
      const shared = roster === "shared";
      if (roster === "empty") {
        config.agents = { entries: {} };
      } else if (shared) {
        config.agents!.entries!.worker = {
          agentDir: requestedDir,
          workspace: "/tmp/worker-workspace",
        };
      }
      const input = { config, agentId, agentDir: requestedDir };
      const candidate = {
        ...ownerSnapshot(config),
        ...input,
        catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
      };
      const project = loadGatewayModelCatalogSnapshot(catalogLoaders(candidate).params);
      if (!bound) {
        await expect(project).rejects.toMatchObject({
          name: "PublishedModelCatalogOwnerResolutionError",
        });
        return;
      }
      const expected = {
        agentId: shared ? "worker" : "main",
        workspaceDir: shared ? "/tmp/worker-workspace" : workspaceDir,
      };
      await expect(project).resolves.toMatchObject(expected);
      const resolved = resolvePublishedModelCatalogOwner(candidate);
      expect(
        resolvePublishedModelCatalogOwner({
          ...resolved,
          catalogOwner: { ...resolved.catalogOwner },
        }),
      ).toEqual(resolved);
    },
  );

  it("rejects a bound catalog without prepared auth", async () => {
    const config = ownerConfig();
    const candidate = { ...ownerSnapshot(config), authStore: undefined };
    await expect(loadGatewayModelCatalogSnapshot(catalogLoaders(candidate).params)).rejects.toThrow(
      "missing prepared auth state",
    );
  });

  it("forwards the requested agent lifecycle owner", async () => {
    const config = ownerConfig("worker");
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ({
      ...ownerSnapshot(config, snapshot, "worker"),
      workspaceDir,
    }));

    const projected = await loadGatewayModelCatalogSnapshot({
      agentId: "worker",
      agentDir,
      getConfig: () => config,
      loadPublishedPreparedModelCatalogOwnerSnapshot,
      workspaceDir,
    });
    expect(projected).toMatchObject({
      agentId: "worker",
      agentDir,
      config,
      workspaceDir,
    } satisfies Partial<GatewayModelCatalogSnapshot>);
    expect(projected).not.toHaveProperty("authStore");
    expect(projected).not.toHaveProperty("metadataSnapshot");
    expect(projected).not.toHaveProperty("pluginRegistry");
    expect(projected).not.toHaveProperty("isCurrent");

    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      agentId: "worker",
      agentDir,
      config,
      readOnly: true,
      workspaceDir,
    });
  });

  it("refreshes auth only for the explicit deferred projection", async () => {
    const config = ownerConfig();
    const candidate = ownerSnapshot(config);
    const loadAuth = vi.fn(async () => ({
      authStore: {
        version: 1 as const,
        profiles: {
          "openai:refreshed": { type: "api_key" as const, provider: "openai", key: "refreshed" },
        },
      },
      authModes: { openai: "api_key" as const },
    }));
    bindPreparedModelRuntimeAuth(candidate, { load: loadAuth });
    const { params, publicLoader } = catalogLoaders(candidate);

    const prepared = await loadPreparedGatewayModelCatalogSnapshot(params);
    expect(prepared.authStore).toEqual(candidate.authStore);
    expect(loadAuth).not.toHaveBeenCalled();

    const loaded = await loadDeferredCatalog(
      { loadGatewayModelCatalogSnapshot: publicLoader },
      "main",
      {
        readOnly: true,
        authScope: { providerIds: ["openai"], profileIds: ["openai:refreshed"] },
        refreshAuth: true,
      },
    );
    expect(loaded.authStore).toEqual(
      expect.objectContaining({ profiles: { "openai:refreshed": expect.any(Object) } }),
    );
    expect(loaded.authModes).toEqual({ openai: "api_key" });
    expect(loadAuth).toHaveBeenCalledWith({
      providerIds: ["openai"],
      profileIds: ["openai:refreshed"],
    });
  });

  it("removes stale prepared auth modes when deferred auth observes logout", async () => {
    const config = ownerConfig();
    const candidate = {
      ...ownerSnapshot(config),
      authModes: { openai: "oauth" as const },
    };
    bindPreparedModelRuntimeAuth(candidate, {
      load: async () => ({ authStore: { version: 1, profiles: {} }, authModes: {} }),
    });

    const { publicLoader } = catalogLoaders(candidate);
    const loaded = await loadDeferredCatalog(
      { loadGatewayModelCatalogSnapshot: publicLoader },
      "main",
      { readOnly: true, refreshAuth: true },
    );

    expect(loaded.authStore?.profiles).toEqual({});
    expect(loaded.authModes).toEqual({});
  });

  it("reports a prepared auth failure when fresh auth was requested", async () => {
    const config = ownerConfig();
    const candidate = ownerSnapshot(config);
    const error = new Error("prepared auth refresh failed");
    bindPreparedModelRuntimeAuth(candidate, {
      load: async () => {
        throw error;
      },
    });

    await expect(
      loadPreparedGatewayModelCatalogSnapshot({
        ...catalogLoaders(candidate).params,
        refreshAuth: true,
      }),
    ).rejects.toBe(error);
  });

  it("selects the full prepared owner when requested", async () => {
    const config = ownerConfig();
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => ownerSnapshot(config));

    await expect(
      loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot,
        readOnly: false,
        refreshFullCatalog: true,
      }),
    ).resolves.toMatchObject(snapshot);
    expect(loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config,
      readOnly: false,
      refreshFullCatalog: true,
    });
  });

  it("does not hide lifecycle publication failures behind stale data", async () => {
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
    const error = new Error("generation failed");
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn(async () => {
      throw error;
    });

    await expect(
      loadGatewayModelCatalogSnapshot({ loadPublishedPreparedModelCatalogOwnerSnapshot }),
    ).rejects.toBe(error);
  });
});
