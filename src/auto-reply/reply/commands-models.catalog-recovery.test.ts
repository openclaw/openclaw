import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { createModelAuthAvailabilityResolver } from "../../agents/model-auth-availability.js";
import * as modelDecisions from "../../agents/model-catalog-decisions.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import * as preparedCatalog from "../../agents/prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelRuntimeAuthStore,
} from "../../agents/prepared-model-runtime-auth.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";

const catalogMocks = vi.hoisted(() => ({
  readSnapshot: vi.fn<(params: unknown) => ModelCatalogSnapshot | undefined>(),
  getPreparedOwner: vi.fn<(params: unknown) => Partial<PreparedModelRuntimeSnapshot> | undefined>(),
  authStore: { version: 1, profiles: {} } as AuthProfileStore,
  authModes: {} as PreparedAgentCredentialModes,
  isCurrent: (): boolean => true,
}));

const { buildPreparedModelsProviderData, resolveModelsCommandReply } =
  await import("./commands-models.js");

const staleCfg = {
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
} as OpenClawConfig;

const replacementCfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
} as OpenClawConfig;

beforeEach(() => {
  vi.spyOn(preparedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockImplementation(
    (params) => {
      if (!params?.config) {
        throw new Error("A catalog read must retain its config");
      }
      const preset = catalogMocks.getPreparedOwner(params);
      const modelCatalog = preset?.modelCatalog ?? catalogMocks.readSnapshot(params);
      if (!modelCatalog) {
        return undefined;
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
        inlineProviderModels: [],
        createStores() {
          throw new Error("Browsing must not start model execution");
        },
        ...preset,
      };
      const retainedAuth = preset ? getPreparedModelRuntimeAuthStore(preset) : undefined;
      setPreparedModelRuntimeAuthStore(owner, retainedAuth ?? catalogMocks.authStore);
      return owner;
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
  it.each(["default", "all"] as const)(
    "rejects a generation retired during %s projection and allows a current retry",
    async (view) => {
      let current = true;
      catalogMocks.isCurrent = () => current;
      const evaluating = createDeferred();
      const resume = createDeferred();
      const evaluateModelAuth = vi.fn(async () => ({
        availability: true as const,
        routeResolution: null,
      }));
      evaluateModelAuth.mockImplementationOnce(async () => {
        evaluating.resolve();
        await resume.promise;
        return { availability: true, routeResolution: null };
      });
      const createDecisions = modelDecisions.createModelCatalogDecisions;
      vi.spyOn(modelDecisions, "createModelCatalogDecisions").mockImplementation((params) => ({
        ...createDecisions(params),
        evaluateEntry: evaluateModelAuth,
      }));
      catalogMocks.readSnapshot.mockReturnValueOnce({
        entries: [{ provider: "anthropic", id: "claude-opus-4-5", name: "Retired model" }],
        routeVariants: [],
      });
      const first = buildPreparedModelsProviderData(staleCfg, undefined, { view });
      const rejected = expect(first).rejects.toBeInstanceOf(
        PreparedModelRuntimePublicationSupersededError,
      );
      await evaluating.promise;
      current = false;
      resume.resolve();
      await rejected;
      catalogMocks.isCurrent = () => true;
      catalogMocks.readSnapshot.mockReturnValueOnce({
        entries: [{ provider: "openai", id: "gpt-5.6-luna", name: "Current model" }],
        routeVariants: [],
      });
      const next = await buildPreparedModelsProviderData(replacementCfg, undefined, { view });
      expect(next.modelNames.get("openai/gpt-5.6-luna")).toBe("Current model");
      expect(next.modelNames.has("anthropic/claude-opus-4-5")).toBe(false);
    },
  );

  it("does not mask an unrelated published-read failure", async () => {
    const failure = new Error("published read failed");
    catalogMocks.readSnapshot.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(buildPreparedModelsProviderData(staleCfg)).rejects.toBe(failure);
  });

  it.each([
    { nativeAuth: true, providerKey: false, disabled: false, visible: true },
    { nativeAuth: false, providerKey: false, disabled: false, visible: false },
    { nativeAuth: false, providerKey: true, disabled: false, visible: false },
    { nativeAuth: true, providerKey: true, disabled: true, visible: false },
  ])(
    "lists bound models using native auth=$nativeAuth, provider key=$providerKey, disabled=$disabled",
    async ({ nativeAuth, providerKey, disabled, visible }) => {
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
      setPreparedModelRuntimeAuthStore(preparedOwner, catalogMocks.authStore);
      catalogMocks.getPreparedOwner.mockReturnValue(preparedOwner);
      catalogMocks.readSnapshot.mockImplementation(() => {
        throw new Error("Published browsing consulted pending acquisition");
      });

      const reply = await resolveModelsCommandReply({
        cfg,
        commandBodyNormalized: "/models anthropic",
        agentId: "main",
      });

      expect(reply?.text?.includes("- anthropic/claude-sonnet-4-6")).toBe(visible);
      expect(reply?.text?.includes("- anthropic/claude-haiku-4-5")).toBe(providerKey);
      expect(reply?.text).toContain("- anthropic/claude-opus-4-5");
    },
  );

  it("keeps unprepared setup hints on provider auth", async () => {
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
    const resolver = createModelAuthAvailabilityResolver({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      env: { ANTHROPIC_API_KEY: "synthetic-provider-key" },
      authStore: { version: 1, profiles: {} },
      skipSetupProviderFallback: true,
      allowPreparedRuntimeAuth: false,
    });

    expect(
      resolver.evaluateModelAuth("anthropic", { modelId: "claude-sonnet-4-6" }).availability,
    ).toBe(true);
  });

  it.each(["pinnedProfileId", "requiredProfileId"] as const)(
    "does not replace an expired %s with a prepared native login",
    async (selection) => {
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
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          selected: {
            provider: "anthropic",
            type: "token",
            token: "synthetic-expired-token",
            expires: 1,
          },
        },
      };
      const resolver = createModelAuthAvailabilityResolver({
        cfg: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
              },
            },
          },
        },
        env: {},
        skipSetupProviderFallback: true,
        preparedRuntimeAuthModes: { "claude-cli": "api_key" },
        authStore: store,
        preparedRuntimeAuthStore: store,
      });

      expect(
        resolver.evaluateRuntimeModelAuth("anthropic", { modelId: "claude-sonnet-4-6" }),
      ).toMatchObject({ availability: true, evidence: "runtime" });
      expect(
        resolver.evaluateRuntimeModelAuth("anthropic", {
          modelId: "claude-sonnet-4-6",
          [selection]: "selected",
        }).availability,
      ).toBe(false);
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
    vi.mocked(preparedCatalog.getPublishedPreparedModelCatalogOwnerSnapshot).mockReturnValueOnce(
      undefined,
    );
    await expect(
      resolveModelsCommandReply({ cfg: staleCfg, commandBodyNormalized: "/models" }),
    ).resolves.toEqual({
      text: "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
    });
  });
});
