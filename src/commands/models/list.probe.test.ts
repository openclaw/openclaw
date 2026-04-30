import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";

let probeModule: typeof import("./list.probe.js");

describe("mapFailoverReasonToProbeStatus", () => {
  beforeAll(async () => {
    vi.doMock("../../agents/pi-embedded.js", () => {
      throw new Error("pi-embedded should stay lazy for probe imports");
    });
    try {
      probeModule = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
    } finally {
      vi.doUnmock("../../agents/pi-embedded.js");
    }
  });

  it("does not import the embedded runner on module load", async () => {
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
  it("forces the PI harness so provider auth probes forward resolved credentials", async () => {
    const runEmbeddedPiAgent = vi.fn(async () => ({ text: "OK" }));
    vi.doMock("../../agents/auth-profiles.js", () => ({
      externalCliDiscoveryScoped: () => undefined,
      ensureAuthProfileStore: () => ({
        version: 1,
        profiles: {
          "openai-codex:soylei": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      }),
      listProfilesForProvider: () => ["openai-codex:soylei"],
      resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
      resolveAuthProfileEligibility: () => ({ eligible: true }),
      resolveAuthProfileOrder: () => ["openai-codex:soylei"],
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      hasUsableCustomProviderApiKey: () => false,
      resolveEnvApiKey: () => null,
    }));
    vi.doMock("../../agents/model-catalog.js", () => ({
      loadModelCatalog: async () => [{ provider: "openai-codex", id: "gpt-5.5" }],
    }));
    vi.doMock("../../agents/pi-embedded.js", () => ({
      runEmbeddedPiAgent,
    }));
    try {
      const module = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
      const result = await module.runAuthProbes({
        cfg: {} as never,
        agentId: "probe-agent",
        agentDir: "/tmp/probe-agent",
        workspaceDir: "/tmp/probe-workspace",
        providers: ["openai-codex"],
        modelCandidates: ["openai-codex/gpt-5.5"],
        options: {
          provider: "openai-codex",
          profileIds: ["openai-codex:soylei"],
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 8,
        },
      });

      expect(result.results[0]?.status).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentHarnessId: "pi",
          authProfileId: "openai-codex:soylei",
          authProfileIdSource: "user",
          disableTools: true,
          modelRun: true,
        }),
      );
    } finally {
      vi.doUnmock("../../agents/auth-profiles.js");
      vi.doUnmock("../../agents/model-auth.js");
      vi.doUnmock("../../agents/model-catalog.js");
      vi.doUnmock("../../agents/pi-embedded.js");
    }
  });
});
