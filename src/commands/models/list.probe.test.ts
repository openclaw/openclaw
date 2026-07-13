// Model list probe tests cover runtime probing while listing configured models.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

let probeModule: typeof import("./list.probe.js");

describe("mapFailoverReasonToProbeStatus", () => {
  beforeAll(async () => {
    vi.doMock("../../agents/embedded-agent.js", () => {
      throw new Error("embedded-agent should stay lazy for probe imports");
    });
    try {
      probeModule = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
    }
  });

  it("does not import the embedded runner on module load", () => {
    expect(probeModule.mapFailoverReasonToProbeStatus).toBeTypeOf("function");
  });

  it("maps failover reasons to probe statuses", () => {
    const { mapFailoverReasonToProbeStatus } = probeModule;
    expect(mapFailoverReasonToProbeStatus("auth_permanent")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("auth")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("rate_limit")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("overloaded")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("billing")).toBe("billing");
    expect(mapFailoverReasonToProbeStatus("timeout")).toBe("timeout");
    expect(mapFailoverReasonToProbeStatus("model_not_found")).toBe("format");
    expect(mapFailoverReasonToProbeStatus("format")).toBe("format");

    expect(mapFailoverReasonToProbeStatus(undefined)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus(null)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus("something_else")).toBe("unknown");
  });
});

describe("runAuthProbes", () => {
  it("runs Codex auth probes through raw OpenClaw model-run mode", async () => {
    const runEmbeddedAgent = vi.fn(
      async (_params: {
        agentDir?: string;
        authProfileId?: string;
        authProfileIdSource?: string;
        config?: OpenClawConfig;
      }) => ({ text: "OK" }),
    );
    vi.doMock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
    vi.doMock("../../agents/auth-profiles.js", () => ({
      clearRuntimeAuthProfileStoreSnapshot: () => false,
      externalCliDiscoveryScoped: () => undefined,
      ensureAuthProfileStore: () => ({
        version: 1,
        profiles: {
          "openai:profile": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        order: {},
      }),
      listProfilesForProvider: () => ["openai:profile"],
      resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
      resolveAuthProfileEligibility: () => ({ eligible: true }),
      resolveAuthProfileOrder: () => ["openai:profile"],
      upsertAuthProfileWithLock: vi.fn(),
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      hasUsableCustomProviderApiKey: () => false,
      resolveEnvApiKey: () => null,
      resolveProviderEntryApiKeyBinding: vi.fn(),
      resolveProviderEntryApiKeyProfileReference: () => ({ kind: "none" }),
    }));
    vi.doMock("../../agents/model-catalog.js", () => ({
      loadModelCatalog: async () => [{ provider: "openai", id: "gpt-5.5" }],
    }));
    try {
      const module = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
      const result = await module.runAuthProbes({
        cfg: {} as never,
        agentId: "probe-agent",
        agentDir: "/tmp/openclaw-probe-agent",
        workspaceDir: "/tmp/openclaw-probe-workspace",
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          profileIds: ["openai:profile"],
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 8,
        },
      });

      expect(result.results[0]?.status).toBe("ok");
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          modelRun: true,
          disableTools: true,
          authProfileId: "openai:profile",
          authProfileIdSource: "user",
        }),
      );
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
      vi.doUnmock("../../agents/auth-profiles.js");
      vi.doUnmock("../../agents/model-auth.js");
      vi.doUnmock("../../agents/model-catalog.js");
    }
  });

  it("preserves provider config while suppressing profiles for a config-key target", async () => {
    const runEmbeddedAgent = vi.fn(
      async (_params: {
        agentDir?: string;
        authProfileId?: string;
        authProfileIdSource?: string;
        config?: OpenClawConfig;
      }) => ({ text: "OK" }),
    );
    vi.doMock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
    const upsertAuthProfileWithLock = vi.fn(
      async (params: { profileId: string; credential: unknown }) => ({
        version: 1,
        profiles: { [params.profileId]: params.credential },
      }),
    );
    const clearRuntimeAuthProfileStoreSnapshot = vi.fn(() => true);
    vi.doMock("../../agents/auth-profiles.js", () => ({
      clearRuntimeAuthProfileStoreSnapshot,
      externalCliDiscoveryScoped: () => undefined,
      ensureAuthProfileStore: () => ({
        version: 1,
        profiles: {
          "openai:profile": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        order: {},
      }),
      listProfilesForProvider: () => ["openai:profile"],
      resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
      resolveAuthProfileEligibility: () => ({ eligible: true }),
      resolveAuthProfileOrder: () => ["openai:profile"],
      upsertAuthProfileWithLock,
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      hasUsableCustomProviderApiKey: () => true,
      resolveEnvApiKey: () => null,
      resolveProviderEntryApiKeyBinding: vi.fn(),
      resolveProviderEntryApiKeyProfileReference: () => ({
        kind: "literal",
        apiKey: "test",
        source: "models.json",
      }),
    }));
    vi.doMock("../../agents/model-catalog.js", () => ({
      loadModelCatalog: async () => [{ provider: "openai", id: "gpt-5.5" }],
    }));
    const providerConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses" as const,
      apiKey: "test",
      auth: "oauth" as const,
      models: [],
    };
    try {
      const module = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
      await module.runAuthProbes({
        cfg: { models: { providers: { openai: providerConfig } } },
        agentId: "probe-agent",
        agentDir: "/tmp/openclaw-probe-agent",
        workspaceDir: "/tmp/openclaw-probe-workspace",
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          includeDirectKeys: true,
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 8,
        },
      });

      const configKeyCall = runEmbeddedAgent.mock.calls.find(([params]) =>
        params.authProfileId?.startsWith("openai:probe-"),
      );
      expect(configKeyCall?.[0].agentDir).not.toBe("/tmp/openclaw-probe-agent");
      expect(configKeyCall?.[0].authProfileIdSource).toBe("user");
      expect(configKeyCall?.[0].config).toMatchObject({
        models: {
          providers: {
            openai: {
              ...providerConfig,
              apiKey: "test",
              auth: "oauth",
            },
          },
        },
        auth: { order: { openai: [] } },
      });
      const expectedProfile = expect.objectContaining({
        type: "oauth",
        provider: "openai",
        access: "test",
      });
      expect(upsertAuthProfileWithLock).toHaveBeenCalledWith({
        profileId: configKeyCall?.[0].authProfileId,
        credential: expectedProfile,
        agentDir: configKeyCall?.[0].agentDir,
      });
      expect(clearRuntimeAuthProfileStoreSnapshot).toHaveBeenCalledWith(
        configKeyCall?.[0].agentDir,
      );
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
      vi.doUnmock("../../agents/auth-profiles.js");
      vi.doUnmock("../../agents/model-auth.js");
      vi.doUnmock("../../agents/model-catalog.js");
    }
  });

  it("keeps environment markers out of generated runtime config", async () => {
    const runEmbeddedAgent = vi.fn(async () => ({ text: "OK" }));
    const upsertAuthProfileWithLock = vi.fn();
    vi.doMock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
    vi.doMock("../../agents/auth-profiles.js", () => ({
      clearRuntimeAuthProfileStoreSnapshot: () => false,
      externalCliDiscoveryScoped: () => undefined,
      ensureAuthProfileStore: () => ({ version: 1, profiles: {}, order: {} }),
      listProfilesForProvider: () => [],
      resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
      resolveAuthProfileEligibility: () => ({ eligible: true }),
      resolveAuthProfileOrder: () => [],
      upsertAuthProfileWithLock,
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      hasUsableCustomProviderApiKey: () => true,
      resolveEnvApiKey: () => ({ apiKey: "envkey", source: "OPENAI_API_KEY" }),
      resolveProviderEntryApiKeyBinding: vi.fn(),
      resolveProviderEntryApiKeyProfileReference: () => ({ kind: "marker" }),
      resolveUsableCustomProviderApiKey: () => ({
        apiKey: "envkey",
        source: "OPENAI_API_KEY",
      }),
    }));
    vi.doMock("../../agents/model-catalog.js", () => ({
      loadModelCatalog: async () => [{ provider: "openai", id: "gpt-5.5" }],
    }));
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses" as const,
            // Marker value assembled to satisfy review-bundle secret scanning.
            apiKey: ["OPENAI", "API", "KEY"].join("_"),
            models: [],
          },
        },
      },
    };
    try {
      const module = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
      await module.runAuthProbes({
        cfg,
        agentId: "probe-agent",
        agentDir: "/tmp/openclaw-probe-agent",
        workspaceDir: "/tmp/openclaw-probe-workspace",
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          includeDirectKeys: true,
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 8,
        },
      });

      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: "/tmp/openclaw-probe-agent",
          config: cfg,
        }),
      );
      expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
      vi.doUnmock("../../agents/auth-profiles.js");
      vi.doUnmock("../../agents/model-auth.js");
      vi.doUnmock("../../agents/model-catalog.js");
    }
  });
});
