// Model list probe tests cover runtime probing while listing configured models.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { assert, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunResultView } from "../../agents/agent-run-result.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../../infra/gateway-lock.js";

let probeModule: typeof import("./list.probe.js");

function createGatewayLockOptions(stateDir: string): GatewayLockOptions {
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    readProcessStartTime: () => 123_456,
    timeoutMs: 100,
  };
}

async function withTempState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-model-probe-lock-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

type RunnerParams = {
  agentDir?: string;
  agentHarnessRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: string;
  config?: OpenClawConfig;
  preparedModelRuntimeMode?: string;
};
type ProbeParams = Parameters<typeof probeModule.runAuthProbes>[0];
function probeInput(
  overrides: Omit<Partial<ProbeParams>, "options"> & { options?: Partial<ProbeParams["options"]> },
): ProbeParams {
  return {
    cfg: {},
    agentId: "probe-agent",
    agentDir: "/tmp/openclaw-probe-agent",
    workspaceDir: "/tmp/openclaw-probe-workspace",
    providers: ["openai"],
    modelCandidates: ["openai/gpt-5.5"],
    ...overrides,
    options: {
      provider: "openai",
      timeoutMs: 5_000,
      concurrency: 1,
      maxTokens: 8,
      ...overrides.options,
    },
  };
}

async function withProbeRuntime(
  credential: "profile" | "literal" | "marker",
  run: (fixture: {
    probe: typeof probeModule;
    runner: ReturnType<typeof createRunner>;
    upsert: ReturnType<typeof createUpsert>;
  }) => Promise<void>,
) {
  const runner = createRunner();
  const upsert = createUpsert();
  const profileIds = credential === "marker" ? [] : ["openai:profile"];
  vi.doMock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runner }));
  vi.doMock("../../agents/auth-profiles.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../agents/auth-profiles.js")>()),
    externalCliDiscoveryScoped: () => undefined,
    ensureAuthProfileStore: () => ({
      version: 1,
      order: {},
      profiles:
        credential === "marker"
          ? {}
          : {
              "openai:profile": {
                type: "oauth",
                provider: "openai",
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60_000,
              },
            },
    }),
    listProfilesForProvider: () => profileIds,
    resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
    resolveAuthProfileEligibility: () => ({ eligible: true }),
    resolveAuthProfileOrder: () => profileIds,
    upsertAuthProfileWithLock: upsert,
  }));
  vi.doMock("../../agents/model-auth.js", () => ({
    hasUsableCustomProviderApiKey: () => credential !== "profile",
    resolveEnvApiKey: () =>
      credential === "marker" ? { apiKey: "envkey", source: "OPENAI_API_KEY" } : null,
    resolveProviderEntryApiKeyBinding: vi.fn(),
    resolveProviderEntryApiKeyProfileReference: () =>
      credential === "literal"
        ? { kind: "literal", apiKey: "test", source: "models.json" }
        : { kind: credential === "marker" ? "marker" : "none" },
    ...(credential === "marker"
      ? {
          resolveUsableCustomProviderApiKey: () => ({ apiKey: "envkey", source: "OPENAI_API_KEY" }),
        }
      : {}),
  }));
  vi.doMock("../../agents/prepared-model-catalog.js", () => ({
    readPreparedModelCatalog: async () => [{ provider: "openai", id: "gpt-5.5" }],
  }));
  try {
    const probe = await importFreshModule<typeof probeModule>(
      import.meta.url,
      `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
    );
    await run({ probe, runner, upsert });
  } finally {
    vi.doUnmock("../../agents/embedded-agent.js");
    vi.doUnmock("../../agents/auth-profiles.js");
    vi.doUnmock("../../agents/model-auth.js");
    vi.doUnmock("../../agents/prepared-model-catalog.js");
  }
}

function createRunner() {
  return vi.fn(async (_params: RunnerParams): Promise<AgentRunResultView> => ({
    payloads: [{ text: "OK" }],
  }));
}
function createUpsert() {
  return vi.fn(async (params: { profileId: string; credential: unknown }) => ({
    version: 1,
    profiles: { [params.profileId]: params.credential },
  }));
}

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
  beforeAll(async () => {
    probeModule ??= await import("./list.probe.js");
  });

  it("refuses direct CLI probes while a live Gateway owns canonical state", async () => {
    await withTempState(async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
      expect(gatewayLock).not.toBeNull();
      if (!gatewayLock) {
        throw new Error("Expected live Gateway fixture lock");
      }
      try {
        await expect(
          probeModule.withAuthProbeStateOwnership(
            { mode: "exclusive", gatewayLockOptions: lockOptions },
            async () => undefined,
          ),
        ).rejects.toThrow(
          `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Stop the Gateway first (openclaw gateway stop), then rerun models status --probe.`,
        );
      } finally {
        await gatewayLock.release();
      }
    });
  });

  it("runs Codex-pinned auth probes through raw OpenClaw model-run mode", async () => {
    await withProbeRuntime("profile", async ({ probe, runner }) => {
      runner.mockImplementation(async (params) => {
        if (params.agentHarnessRuntimeOverride !== "openclaw") {
          throw new Error("Codex cannot reproduce authored request transport overrides");
        }
        return { payloads: [{ text: "OK" }] };
      });
      const input = probeInput({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                agentRuntime: { id: "codex" },
                models: [],
              },
            },
          },
        },
        options: { profileIds: ["openai:profile"] },
      });
      expect((await probe.runAuthProbes(input)).results[0]?.status).toBe("ok");
      expect(runner).toHaveBeenCalledWith(
        expect.objectContaining({
          agentHarnessRuntimeOverride: "openclaw",
          modelRun: true,
          disableTools: true,
          modelFallbacksOverride: [],
          authProfileId: "openai:profile",
          authProfileIdSource: "user",
        }),
      );
      expect(runner.mock.calls[0]?.[0].preparedModelRuntimeMode).toBeUndefined();
      runner.mockResolvedValueOnce({
        payloads: [{ text: "LLM request timed out.", isError: true }],
        meta: { livenessState: "abandoned" },
      });
      expect((await probe.runAuthProbes(input)).results[0]).toMatchObject({ status: "timeout" });
    });
  });

  it("preserves provider config while suppressing profiles for a config-key target", async () => {
    await withProbeRuntime("literal", async ({ probe, runner, upsert }) => {
      const providerConfig = {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses" as const,
        apiKey: "test",
        auth: "oauth" as const,
        models: [],
      };
      await probe.runAuthProbes(
        probeInput({
          cfg: { models: { providers: { openai: providerConfig } } },
          options: { includeDirectKeys: true },
        }),
      );
      const call = runner.mock.calls.find(([params]) =>
        params.authProfileId?.startsWith("openai:probe-"),
      )?.[0];
      assert(call?.agentDir);
      expect(call.agentDir).not.toBe("/tmp/openclaw-probe-agent");
      expect(call.authProfileIdSource).toBe("user");
      expect(call.preparedModelRuntimeMode).toBe("isolated-read-only");
      expect(call.config).toMatchObject({
        models: { providers: { openai: providerConfig } },
        auth: { order: { openai: [] } },
      });
      expect(upsert).toHaveBeenCalledWith({
        profileId: call.authProfileId,
        agentDir: call.agentDir,
        credential: expect.objectContaining({ type: "oauth", provider: "openai", access: "test" }),
      });
      await expect(fs.stat(call.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("isolates marker credentials from stored profiles without pinning a synthetic one", async () => {
    await withProbeRuntime("marker", async ({ probe, runner, upsert }) => {
      const cfg = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses" as const,
              apiKey: ["OPENAI", "API", "KEY"].join("_"),
              models: [],
            },
          },
        },
      };
      await probe.runAuthProbes(probeInput({ cfg, options: { includeDirectKeys: true } }));
      const call = runner.mock.calls[0]?.[0];
      expect(call?.agentDir).not.toBe("/tmp/openclaw-probe-agent");
      expect(call?.agentDir).toContain("openclaw-auth-probe-");
      expect(call?.preparedModelRuntimeMode).toBe("isolated-read-only");
      expect(call?.config?.auth?.order?.openai).toEqual([]);
      expect(call?.config?.models?.providers?.openai?.apiKey).toBe(
        cfg.models.providers.openai.apiKey,
      );
      expect(call?.authProfileId).toBeUndefined();
      expect(upsert).not.toHaveBeenCalled();
    });
  });
});
