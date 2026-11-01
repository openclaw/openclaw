import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import { prepareSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  createClaudeCliBackends,
  testing as cliBackendsTesting,
} from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import {
  bindPreparedModelRuntimeAuth,
  setPreparedModelFullCatalogAuth,
} from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "../../agents/prepared-model-runtime.errors.js";
import * as preparedRuntime from "../../agents/prepared-model-runtime.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { buildPreparedModelsProviderData } from "./commands-models-catalog.js";
import { handleModelsCommand, resolveModelsCommandReply } from "./commands-models.js";
import { createModelsTestOwner } from "./commands-models.test-support.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const catalogMocks = vi.hoisted(() => ({
  readSnapshot: vi.fn<(params: unknown) => ModelCatalogSnapshot | undefined>(),
  owner: undefined as Partial<PreparedModelRuntimeSnapshot> | undefined,
  authStore: { version: 1, profiles: {} } as AuthProfileStore,
  authModes: {} as PreparedAgentCredentialModes,
}));

const staleCfg = {
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
} as OpenClawConfig;
const notReady = "Model catalog is not ready. Retry after Gateway startup or refresh finishes.";
function catalog(...ids: string[]): ModelCatalogSnapshot {
  return { entries: ids.map((id) => ({ provider: "anthropic", id, name: id })), routeVariants: [] };
}
function browse(commandBodyNormalized = "/models anthropic", cfg = staleCfg) {
  return resolveModelsCommandReply({ cfg, agentId: "main", commandBodyNormalized });
}

beforeEach(() => {
  vi.spyOn(preparedCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot").mockImplementation(
    async (params) => {
      if (!params?.config) {
        throw new Error("A catalog read must retain its config");
      }
      const preset = catalogMocks.owner;
      const modelCatalog = preset?.modelCatalog ?? catalogMocks.readSnapshot(params);
      if (!modelCatalog) {
        throw new PreparedModelRuntimeOwnerNotPublishedError(notReady);
      }
      const owner: PreparedModelRuntimeSnapshot = {
        ...createModelsTestOwner(params.config, modelCatalog.entries, params),
        authModes: catalogMocks.authModes,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "anthropic", cliBackends: ["claude-cli"] }],
        }),
        modelCatalog,
        ...preset,
      };
      bindPreparedModelRuntimeAuth(owner, { store: catalogMocks.authStore });
      return preparedCatalog.materializePreparedModelCatalogOwner(owner);
    },
  );
});

afterEach(() => {
  catalogMocks.readSnapshot.mockReset();
  catalogMocks.owner = undefined;
  catalogMocks.authStore = { version: 1, profiles: {} };
  catalogMocks.authModes = {};
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("replies with known models while acquisition is held and includes newly published rows next time", async ({
  signal,
}) => {
  const pendingCatalog = { ...catalog("claude-opus-4-5"), pendingProviders: ["anthropic"] };
  const refreshedCatalog = catalog("claude-opus-4-5", "claude-sonnet-4-6");
  catalogMocks.authStore.profiles["anthropic:default"] = {
    type: "api_key",
    provider: "anthropic",
    key: "synthetic-catalog-key",
  };
  catalogMocks.authModes = { anthropic: "api_key" };
  catalogMocks.readSnapshot.mockReturnValue(pendingCatalog);
  const acquisition = createDeferred<ModelCatalogSnapshot>();
  const published = createDeferred();
  let completedCatalog: ModelCatalogSnapshot | undefined;
  catalogMocks.owner = {
    readFullModelCatalog: () => completedCatalog,
    loadFullModelCatalog: async () => {
      completedCatalog = await acquisition.promise;
      published.resolve();
      return completedCatalog;
    },
  };
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
  await prepareSharedAuthStoreOwnership();
  try {
    const reply = await withinTest(browse(), signal);
    expect(reply?.text).toContain("- anthropic/claude-opus-4-5");
    expect(reply?.text).toContain("anthropic: checking models…");
    expect(reply?.text).not.toContain("claude-sonnet-4-6");
    acquisition.resolve(refreshedCatalog);
    await withinTest(published.promise, signal);
    const next = await withinTest(browse(), signal);
    expect(next?.text).toContain("- anthropic/claude-sonnet-4-6");
    expect(next?.text).not.toContain("checking models");
  } finally {
    acquisition.resolve(refreshedCatalog);
  }
});

it("keeps usable choices and clears the refresh warning after recovery for /models", async () => {
  const snapshot = { ...catalog("claude-opus-4-5"), refreshFailed: true };
  catalogMocks.readSnapshot.mockReturnValue(snapshot);
  const params = buildCommandTestParams("/models", staleCfg);

  const failedRefresh = await handleModelsCommand(params, true);

  expect(failedRefresh?.shouldContinue).toBe(false);
  expect(failedRefresh?.reply?.text).toContain("Some models could not be refreshed.");
  expect(failedRefresh?.reply?.text).toContain("- anthropic (1)");
  snapshot.refreshFailed = false;
  const recovered = await handleModelsCommand(params, true);
  expect(recovered?.shouldContinue).toBe(false);
  expect(recovered?.reply?.text).not.toContain("Some models could not be refreshed.");
  expect(recovered?.reply?.text).toContain("- anthropic (1)");
});

it("lists bound models as unavailable when the native-auth plugin is disabled despite a provider key", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-provider-key");
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: createClaudeCliBackends,
  });
  catalogMocks.authModes = { "claude-cli": "api_key" };
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
        modelPolicy: { allow: [] },
        models: {
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
        },
      },
    },
    plugins: { entries: { anthropic: { enabled: false } } },
  };
  catalogMocks.owner = {
    modelCatalog: catalog("claude-opus-4-5", "claude-sonnet-4-6", "claude-haiku-4-5"),
  };
  catalogMocks.readSnapshot.mockImplementation(() => {
    throw new Error("Published browsing consulted pending acquisition");
  });

  const reply = await browse("/models anthropic", cfg);

  expect(reply?.text).toContain("- anthropic/claude-sonnet-4-6 (Sign-in needed");
  expect(reply?.text).toContain("run claude auth login on the Gateway host");
  expect(reply?.text).toContain("- anthropic/claude-haiku-4-5");
  expect(reply?.text).toContain("- anthropic/claude-opus-4-5");
});

it.each([false, true])(
  "projects prepared external OAuth with explicit exclusion=%s",
  async (excluded) => {
    catalogMocks.authStore.profiles["openai:external"] = {
      type: "oauth",
      provider: "openai",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 3_600_000,
    };
    catalogMocks.authStore.runtimeExternalProfileIds = ["openai:external"];
    if (excluded) {
      catalogMocks.authStore.order = { openai: [] };
    }
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
  await expect(browse("/models")).resolves.toEqual({ text: notReady });
});
