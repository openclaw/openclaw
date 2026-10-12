import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthStore,
  bindPreparedModelRuntimeAuth,
  setPreparedModelFullCatalogAuth,
} from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "../../agents/prepared-model-runtime.errors.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ReplyPayload } from "../types.js";
import { buildPreparedModelsProviderData } from "./commands-models-catalog.js";
import { handleModelsCommand, resolveModelsCommandReply } from "./commands-models.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const catalogMocks = vi.hoisted(() => ({
  readSnapshot: vi.fn<(params: unknown) => ModelCatalogSnapshot | undefined>(),
  getPreparedOwner: vi.fn<(params: unknown) => Partial<PreparedModelRuntimeSnapshot> | undefined>(),
  authStore: { version: 1, profiles: {} } as AuthProfileStore,
  authModes: {} as PreparedAgentCredentialModes,
  isCurrent: (): boolean => true,
}));

const staleCfg = {
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
} as OpenClawConfig;

beforeEach(() => {
  vi.spyOn(preparedCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot").mockImplementation(
    async (params) => {
      if (!params?.config) {
        throw new Error("A catalog read must retain its config");
      }
      const preset = catalogMocks.getPreparedOwner(params);
      const modelCatalog = preset?.modelCatalog ?? catalogMocks.readSnapshot(params);
      if (!modelCatalog) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
        );
      }
      const owner: PreparedModelRuntimeSnapshot = {
        catalogOwner: {
          agentId: params.agentId ?? "main",
          workspaceDir: params.workspaceDir ?? "/tmp",
        },
        agentId: params.agentId ?? "main",
        agentDir: params.agentDir ?? "/tmp/published-model-agent",
        workspaceDir: params.workspaceDir ?? "/tmp",
        activeProjectKeys: [],
        config: params.config,
        observationConfig: params.config,
        authModes: catalogMocks.authModes,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "anthropic", cliBackends: ["claude-cli"] }],
        }),
        isCurrent: catalogMocks.isCurrent,
        allowGatewaySubagentBinding: false,
        modelCatalog,
        configuredRuntimeModels: [],
        findConfiguredRuntimeModel: () => undefined,
        inlineProviderModels: [],
        createStores() {
          throw new Error("Browsing must not start model execution");
        },
        ...preset,
      };
      const retainedAuth = preset ? getPreparedModelRuntimeAuthStore(preset) : undefined;
      bindPreparedModelRuntimeAuth(owner, { store: retainedAuth ?? catalogMocks.authStore });
      return preparedCatalog.materializePreparedModelCatalogOwner(owner);
    },
  );
});

afterEach(() => {
  catalogMocks.readSnapshot.mockReset();
  catalogMocks.getPreparedOwner.mockReset();
  catalogMocks.authStore = { version: 1, profiles: {} };
  catalogMocks.authModes = {};
  catalogMocks.isCurrent = () => true;
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/models browse catalog recovery", () => {
  it("replies with known models while acquisition is held and includes newly published rows next time", async () => {
    const pendingCatalog: ModelCatalogSnapshot = {
      entries: [{ provider: "anthropic", id: "claude-opus-4-5", name: "Known model" }],
      routeVariants: [],
      pendingProviders: ["anthropic"],
    };
    const refreshedCatalog: ModelCatalogSnapshot = {
      entries: [
        ...pendingCatalog.entries,
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Discovered model" },
      ],
      routeVariants: [],
    };
    catalogMocks.authStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "synthetic-catalog-key",
        },
      },
    };
    catalogMocks.authModes = { anthropic: "api_key" };
    catalogMocks.readSnapshot.mockReturnValue(pendingCatalog);
    const acquisition = createDeferred<ModelCatalogSnapshot>();
    let completedCatalog: ModelCatalogSnapshot | undefined;
    catalogMocks.getPreparedOwner.mockReturnValue({
      readFullModelCatalog: () => completedCatalog,
      loadFullModelCatalog: async () => {
        completedCatalog = await acquisition.promise;
        return completedCatalog;
      },
    });
    const owner = await preparedCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot({
      config: staleCfg,
    });
    setPreparedModelFullCatalogAuth(refreshedCatalog, {
      authStore: catalogMocks.authStore,
      authModes: catalogMocks.authModes,
      providerAuthLabels: new Map(),
    });
    vi.mocked(preparedCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot).mockRestore();
    vi.spyOn(preparedRuntime, "getPreparedModelRuntimeSnapshot").mockReturnValue(owner);
    vi.spyOn(preparedRuntime, "prepareModelRuntimeSnapshot").mockResolvedValue(owner);
    vi.useFakeTimers();
    try {
      const params = { cfg: staleCfg, agentId: "main", commandBodyNormalized: "/models anthropic" };
      let reply: ReplyPayload | null | undefined;
      const first = resolveModelsCommandReply(params).then((result) => {
        reply = result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(reply?.text).toContain("- anthropic/claude-opus-4-5");
      expect(reply?.text).toContain("anthropic: checking models…");
      expect(reply?.text).not.toContain("claude-sonnet-4-6");
      acquisition.resolve(refreshedCatalog);
      await first;
      await vi.advanceTimersByTimeAsync(0);
      const next = await resolveModelsCommandReply(params);
      expect(next?.text).toContain("- anthropic/claude-sonnet-4-6");
      expect(next?.text).not.toContain("checking models");
    } finally {
      acquisition.resolve(refreshedCatalog);
      vi.useRealTimers();
    }
  });

  it.each([{ commandBodyNormalized: "/models", choice: "- anthropic (1)" }])(
    "keeps usable choices and clears the refresh warning after recovery for $commandBodyNormalized",
    async ({ commandBodyNormalized, choice }) => {
      const snapshot: ModelCatalogSnapshot = {
        entries: [{ provider: "anthropic", id: "claude-opus-4-5", name: "Available model" }],
        routeVariants: [],
        refreshFailed: true,
      };
      catalogMocks.readSnapshot.mockReturnValue(snapshot);
      const params = buildCommandTestParams(commandBodyNormalized, staleCfg);

      const failedRefresh = await handleModelsCommand(params, true);

      expect(failedRefresh?.shouldContinue).toBe(false);
      expect(failedRefresh?.reply?.text).toContain("Some models could not be refreshed.");
      expect(failedRefresh?.reply?.text).toContain(choice);
      snapshot.refreshFailed = false;
      const recovered = await handleModelsCommand(params, true);
      expect(recovered?.shouldContinue).toBe(false);
      expect(recovered?.reply?.text).not.toContain("Some models could not be refreshed.");
      expect(recovered?.reply?.text).toContain(choice);
    },
  );

  it.each([{ nativeAuth: true, providerKey: true, disabled: true, available: false }])(
    "lists bound models using native auth=$nativeAuth, provider key=$providerKey, disabled=$disabled",
    async ({ nativeAuth, providerKey, disabled, available }) => {
      vi.stubEnv("ANTHROPIC_API_KEY", providerKey ? "synthetic-provider-key" : "");
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            pluginId: "anthropic",
            config: { command: "claude" },
          },
        ],
      });
      catalogMocks.authModes = nativeAuth ? { "claude-cli": "api_key" } : {};
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
            modelPolicy: { allow: [] },
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
        ...(disabled ? { plugins: { entries: { anthropic: { enabled: false } } } } : {}),
      };
      const snapshot = {
        entries: [
          { provider: "anthropic", id: "claude-opus-4-5", name: "Default" },
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "Bound" },
          { provider: "anthropic", id: "claude-haiku-4-5", name: "Unbound" },
        ],
        routeVariants: [],
      };
      const preparedOwner = {
        modelCatalog: snapshot,
        authModes: catalogMocks.authModes,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "anthropic", cliBackends: ["claude-cli"] }],
        }),
        isCurrent: () => true,
      };
      bindPreparedModelRuntimeAuth(preparedOwner, { store: catalogMocks.authStore });
      catalogMocks.getPreparedOwner.mockReturnValue(preparedOwner);
      catalogMocks.readSnapshot.mockImplementation(() => {
        throw new Error("Published browsing consulted pending acquisition");
      });

      const reply = await resolveModelsCommandReply({
        cfg,
        commandBodyNormalized: "/models anthropic",
        agentId: "main",
      });

      expect(reply?.text).toContain("- anthropic/claude-sonnet-4-6");
      expect(reply?.text?.includes("- anthropic/claude-sonnet-4-6 (Sign-in needed")).toBe(
        !available,
      );
      expect(reply?.text?.includes("run claude auth login on the Gateway host")).toBe(!available);
      expect(reply?.text?.includes("- anthropic/claude-haiku-4-5")).toBe(providerKey);
      expect(reply?.text).toContain("- anthropic/claude-opus-4-5");
    },
  );

  it.each([false, true])(
    "projects prepared external OAuth with explicit exclusion=%s",
    async (excluded) => {
      catalogMocks.authStore = {
        version: 1,
        profiles: {
          "openai:external": {
            type: "oauth",
            provider: "openai",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 3_600_000,
          },
        },
        runtimeExternalProfileIds: ["openai:external"],
        ...(excluded ? { order: { openai: [] } } : {}),
      };
      const subscription = {
        provider: "openai",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      };
      catalogMocks.readSnapshot.mockReturnValueOnce({
        entries: [subscription],
        routeVariants: [subscription],
      });

      const data = await buildPreparedModelsProviderData(staleCfg);

      expect(data.providers.includes("openai")).toBe(!excluded);
      if (!excluded) {
        expect(data.modelCatalog.find((entry) => entry.provider === "openai")).toMatchObject({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        });
      }
    },
  );

  it("returns visible not-ready guidance from the public models command", async () => {
    vi.mocked(preparedCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot).mockRejectedValueOnce(
      new PreparedModelRuntimeOwnerNotPublishedError(
        "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
      ),
    );
    await expect(
      resolveModelsCommandReply({ cfg: staleCfg, commandBodyNormalized: "/models" }),
    ).resolves.toEqual({
      text: "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
    });
  });
});
