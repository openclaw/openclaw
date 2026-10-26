import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { preparePublishedModelCatalogOwnerIdentity } from "../agents/prepared-model-catalog-owner.js";
import type { PublishedModelCatalogOwnerCandidate } from "../agents/prepared-model-catalog.types.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as currentPluginMetadata from "../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  loadDeferredCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "./server-model-catalog-auth.js";
import {
  createPreparedGatewayModelCatalog,
  readPreparedGatewayModelCatalogMetadata,
  readPreparedGatewaySessionRowPolicy,
} from "./server-model-catalog-view.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
} from "./server-model-catalog.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";
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
    agents: { ...extra.agents, entries: { [agentId]: { agentDir, workspace: workspaceDir } } },
  };
}

function ownerSnapshot(
  config: OpenClawConfig = ownerConfig(),
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
    modelCatalog: snapshot,
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

function rowFacts(
  entry: Parameters<typeof readSessionRowModelFacts>[0]["entry"],
  catalog: ReturnType<typeof createPreparedGatewayModelCatalog>,
  extra: Partial<Parameters<typeof readSessionRowModelFacts>[0]> = {},
) {
  return readSessionRowModelFacts({
    cfg: ownerConfig(),
    key: "agent:main:prepared-catalog",
    agentId: "main",
    entry,
    source: { entry, readSourceEntry: () => undefined },
    rowContext: buildSessionListRowMetadataContext({ now: 1 }),
    modelCatalog: new Map([["main", catalog]]),
    lightweightListRow: true,
    ...extra,
  });
}

describe("gateway prepared model catalog", () => {
  it("omits row comparison work for display reads while retaining eager projection snapshots", () => {
    let reads = 0;
    let contextTokens = 8_192;
    const entry = {
      provider: "fixture",
      id: "model",
      name: "Model",
      get contextTokens() {
        reads++;
        return contextTokens;
      },
    };
    const input = {
      entries: [entry],
      routeVariants: [entry],
      pluginRegistry: createEmptyPluginRegistry(),
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
    };
    const display = createPreparedGatewayModelCatalog({
      ...input,
      includeSessionRowPolicy: false,
    });
    expect(reads).toBe(0);
    expect(display.entries).toBe(input.entries);
    expect(display.routeVariants).toBe(input.routeVariants);
    expect(display.pluginRegistry).toBe(input.pluginRegistry);
    expect(readPreparedGatewayModelCatalogMetadata(display)).toBe(input.metadataSnapshot);
    expect(readPreparedGatewaySessionRowPolicy(display)).toBeUndefined();

    const projection = createPreparedGatewayModelCatalog(input);
    contextTokens = 16_384;
    expect(readPreparedGatewaySessionRowPolicy(projection)).toMatchObject({
      entries: [{ data: { contextTokens: 8_192 } }],
      routeVariants: [{ data: { contextTokens: 8_192 } }],
    });
  });

  it("keeps a prepared metadata miss separate from the current runtime generation", async () => {
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
    const current = createPreparedGatewayModelCatalog({
      entries: [],
      metadataSnapshot: currentMetadata,
    });
    withPluginRuntimeGenerationScope({ metadataSnapshot: currentMetadata }, () => {
      const entry = {
        sessionId: "prepared-catalog",
        updatedAt: 1,
        providerOverride: "custom",
        modelOverride: "latest",
      };
      const facts = rowFacts(entry, absent, { preparedModelMetadata: currentMetadata });
      expect(facts.selectedModel).toMatchObject({ provider: "custom", model: "latest" });
      const cliEntry = {
        ...entry,
        providerOverride: "catalog-generation-cli",
        modelOverride: "custom/shared-model",
        modelOverrideRouteResolution: "resolved" as const,
      };
      const rowContext = buildSessionListRowMetadataContext({ now: 1 });
      for (const catalog of [absent, current, absent]) {
        const cliFacts = rowFacts(cliEntry, catalog, {
          rowContext,
          key: "agent:main:prepared-cli",
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
      connect: gatewayConnect(["operator.read"]),
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
    },
  );

  it("rejects a bound catalog without prepared auth", async () => {
    const candidate = { ...ownerSnapshot(), authStore: undefined };
    await expect(loadGatewayModelCatalogSnapshot(catalogLoaders(candidate).params)).rejects.toThrow(
      "missing prepared auth state",
    );
  });

  it.each([
    { agentId: "worker", agentDir, workspaceDir },
    { readOnly: false, refreshFullCatalog: true },
  ])("forwards the requested lifecycle owner: %j", async (options) => {
    const candidate = ownerSnapshot(ownerConfig("worker"), "worker");
    const { params } = catalogLoaders(candidate);
    const projected = await loadGatewayModelCatalogSnapshot({ ...params, ...options });
    expect(projected).toMatchObject({
      ...snapshot,
      agentId: "worker",
      agentDir,
      config: candidate.config,
      workspaceDir,
    });
    for (const key of ["authStore", "metadataSnapshot", "pluginRegistry", "isCurrent"]) {
      expect(projected).not.toHaveProperty(key);
    }
    expect(params.loadPublishedPreparedModelCatalogOwnerSnapshot).toHaveBeenCalledWith({
      config: candidate.config,
      readOnly: true,
      ...options,
    });
  });

  it.each(["refresh", "logout"])(
    "defers prepared auth updates until requested: %s",
    async (mode) => {
      const candidate = { ...ownerSnapshot(), authModes: { openai: "oauth" as const } };
      const credential = { type: "api_key" as const, provider: "openai", key: "refreshed" };
      const profiles: Record<string, typeof credential> =
        mode === "logout" ? {} : { "openai:refreshed": credential };
      const authModes: PublishedModelCatalogOwnerCandidate["authModes"] =
        mode === "logout" ? {} : { openai: "api_key" };
      const scope = { providerIds: ["openai"], profileIds: ["openai:refreshed"] };
      const authScope = mode === "logout" ? undefined : scope;
      const loadAuth = vi.fn(async () => ({
        authStore: { version: 1 as const, profiles },
        authModes,
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
          authScope,
          refreshAuth: true,
        },
      );
      expect(loaded.authStore?.profiles).toEqual(profiles);
      expect(loaded.authModes).toEqual(mode === "logout" ? {} : { openai: "api_key" });
      expect(loadAuth).toHaveBeenCalledWith(authScope ?? { providerIds: ["openai"] });
    },
  );

  it("reports a prepared auth failure when fresh auth was requested", async () => {
    const candidate = ownerSnapshot();
    const error = new Error("prepared auth refresh failed");
    bindPreparedModelRuntimeAuth(candidate, { load: vi.fn().mockRejectedValue(error) });

    await expect(
      loadPreparedGatewayModelCatalogSnapshot({
        ...catalogLoaders(candidate).params,
        refreshAuth: true,
      }),
    ).rejects.toBe(error);
  });

  it("does not hide lifecycle publication failures behind stale data", async () => {
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
    const error = new Error("generation failed");
    const loadPublishedPreparedModelCatalogOwnerSnapshot = vi.fn().mockRejectedValue(error);

    await expect(
      loadGatewayModelCatalogSnapshot({ loadPublishedPreparedModelCatalogOwnerSnapshot }),
    ).rejects.toBe(error);
  });
});
