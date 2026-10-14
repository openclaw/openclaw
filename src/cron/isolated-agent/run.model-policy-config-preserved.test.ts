import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveExtraParams } from "../../agents/embedded-agent-runner/extra-params.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { resolveAllowedModelRefCore } from "../../agents/model-selection-resolve.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import type { ResolvedPublishedModelCatalogOwner } from "../../agents/prepared-model-catalog.types.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemorySearchConfig } from "../../config/types.tools.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveCronModelSelection } from "./model-selection.js";
import { resolveCronAgentConfig } from "./run-config.js";

function buildCronConfig(cfg: OpenClawConfig, agentId: string): OpenClawConfig {
  return resolveCronAgentConfig({
    config: cfg,
    agentConfigOverride: resolveAgentConfig(cfg, agentId),
  }).cfgWithAgentDefaults;
}

function resolveCronPayloadModel(cfg: OpenClawConfig, raw: string) {
  return resolveAllowedModelRefCore({
    cfg,
    catalog: [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    ],
    raw,
    defaultProvider: "openai",
    defaultModel: "baseline",
    manifestPlugins: [],
  });
}

describe("resolveCronAgentConfig model policy preservation", () => {
  it("keeps ACP harness models out of native defaults while preserving empty fallbacks", async () => {
    const fallbacks: string[] = [];
    const primary = "native/primary@native:test-profile";
    const defaultModel = { primary, fallbacks: ["native/default-backup"] };
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: { model: defaultModel },
        entries: {
          worker: {
            runtime: { type: "acp" },
            model: {
              primary: "harness-only[reasoning=medium]",
              fallbacks,
            },
          },
        },
      },
    };
    const owner = {
      config: cfg,
      agentId: "worker",
      agentDir: "/tmp/cron-acp-agent",
      workspaceDir: "/tmp/cron-acp-workspace",
      metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [] }),
      modelCatalog: { entries: [], routeVariants: [] },
    };
    const result = await resolveCronModelSelection({
      cfg,
      owner,
      agentConfigOverride: resolveAgentConfig(cfg, owner.agentId),
      agentId: owner.agentId,
      agentDir: owner.agentDir,
      workspaceDir: owner.workspaceDir,
      payload: { kind: "agentTurn", message: "scheduled work" },
      sessionEntry: {},
      isGmailHook: false,
    });
    expect(result).toMatchObject({
      ok: true,
      provider: "native",
      model: "primary",
      modelSource: "default",
      configuredProfileId: "native:test-profile",
      cfgWithAgentDefaults: {
        agents: {
          defaults: {
            model: { primary, fallbacks },
          },
        },
      },
    });
  });

  it("keeps per-agent model parameters and controls without flattening their catalog", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/test-model",
          models: {
            "openai/test-model": {
              agentRuntime: { id: "openclaw" },
              params: {
                maxTokens: 2048,
                topP: 0.6,
                thinking: "high",
                fastMode: false,
                fastAutoOnSeconds: 60,
              },
            },
          },
        },
        entries: {
          worker: {
            models: {
              "openai/test-model": {
                params: {
                  max_tokens: 1536,
                  thinking: "low",
                  fast_mode: "auto",
                  fast_seconds: 20,
                },
              },
            },
            params: { temperature: 0.4 },
          },
        },
      },
    };
    const selection = {
      cfg: buildCronConfig(cfg, "worker"),
      agentId: "worker",
      provider: "openai",
      model: "test-model",
    };
    expect(resolveExtraParams({ ...selection, modelId: selection.model })).toMatchObject({
      maxTokens: 1536,
      topP: 0.6,
      temperature: 0.4,
    });
    expect(resolveConfiguredThinkingDefault(selection)).toBe("low");
    expect(resolveFastModeState(selection)).toMatchObject({ mode: "auto", fastAutoOnSeconds: 20 });
  });

  it("keeps the inherited default restriction when the per-agent policy is empty", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        entries: { worker: { modelPolicy: {} } },
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.modelPolicy).toEqual({ allow: ["openai/gpt-5.5"] });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.6-sol")).toEqual({
      error: "model not allowed: openai/gpt-5.6-sol",
    });
  });

  it("applies an explicit per-agent allowlist to cron model resolution", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        entries: { worker: { modelPolicy: { allow: ["openai/gpt-5.6-sol"] } } },
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.modelPolicy).toEqual({ allow: ["openai/gpt-5.6-sol"] });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.5")).toEqual({
      error: "model not allowed: openai/gpt-5.5",
    });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.6-sol")).toMatchObject({
      ref: { provider: "openai", model: "gpt-5.6-sol" },
    });
  });

  it.each(["agent", "hook"] as const)(
    "keeps the selected owner's metadata for the %s model",
    async (source) => {
      const snapshot = (workspaceDir: string, model: string) => ({
        ...createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "cron-model-policy",
              modelIdNormalization: {
                providers: {
                  custom: { aliases: { legacy: model } },
                  [DEFAULT_PROVIDER]: { aliases: { legacy: model } },
                },
              },
            },
          ],
        }),
        workspaceDir,
      });
      const metadataSnapshot = snapshot("/tmp/cron-owner", "selected");
      const otherWorkspace = snapshot("/tmp/other-owner", "other");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "custom/baseline" },
            modelPolicy: { allow: ["custom/legacy", `${DEFAULT_PROVIDER}/legacy`] },
          },
          entries: {
            worker: {
              agentDir: "/tmp/cron-agent",
              workspace: metadataSnapshot.workspaceDir,
              ...(source === "agent" ? { model: "custom/legacy" } : {}),
            },
          },
        },
        ...(source === "hook" ? { hooks: { gmail: { model: "legacy" } } } : {}),
      };
      const owner: ResolvedPublishedModelCatalogOwner = {
        catalogOwner: { agentId: "worker", workspaceDir: metadataSnapshot.workspaceDir },
        agentId: "worker",
        agentDir: "/tmp/cron-agent",
        workspaceDir: metadataSnapshot.workspaceDir,
        config: cfg,
        observationConfig: cfg,
        isCurrent: () => true,
        authModes: {},
        authStore: { version: 1, profiles: {} },
        metadataSnapshot,
        modelCatalog: { entries: [], routeVariants: [] },
      };
      for (const ambient of [metadataSnapshot, otherWorkspace]) {
        const result = await withPluginRuntimeGenerationScope({ metadataSnapshot: ambient }, () =>
          resolveCronModelSelection({
            cfg,
            owner,
            agentConfigOverride: resolveAgentConfig(cfg, owner.agentId),
            agentId: owner.agentId,
            agentDir: owner.agentDir,
            workspaceDir: owner.workspaceDir,
            payload: {
              kind: "agentTurn",
              message: "scheduled work",
            },
            sessionEntry: {},
            isGmailHook: source === "hook",
          }),
        );
        expect(result).toMatchObject({
          ok: true,
          provider: source === "hook" ? DEFAULT_PROVIDER : "custom",
          model: "selected",
          modelSource: source,
        });
      }
    },
  );
});

const defaultSandbox = {
  mode: "all" as const,
  workspaceAccess: "rw" as const,
  docker: {
    network: "none",
    dangerouslyAllowContainerNamespaceJoin: true,
    dangerouslyAllowExternalBindSources: true,
  },
  browser: {
    enabled: true,
    autoStart: false,
  },
  prune: {
    maxAgeDays: 7,
  },
};

function buildRunCfg(
  agentId: string,
  agentConfigOverride: Parameters<typeof resolveCronAgentConfig>[0]["agentConfigOverride"],
) {
  const { cfgWithAgentDefaults } = resolveCronAgentConfig({
    config: { agents: { defaults: { sandbox: structuredClone(defaultSandbox) } } },
    agentConfigOverride,
  });
  return {
    ...cfgWithAgentDefaults,
    agents: {
      ...cfgWithAgentDefaults.agents,
      entries: { [agentId]: { ...agentConfigOverride } },
    },
  };
}

describe("runCronIsolatedAgentTurn sandbox config preserved", () => {
  it("keeps global sandbox defaults when agent override is partial", () => {
    const runCfg = buildRunCfg("specialist", {
      sandbox: {
        docker: {
          image: "ghcr.io/openclaw/sandbox:custom",
        },
        browser: {
          image: "ghcr.io/openclaw/browser:custom",
        },
        prune: {
          idleHours: 1,
        },
      },
    });
    const resolvedSandbox = resolveSandboxConfigForAgent(runCfg, "specialist");

    expect(runCfg.agents.defaults?.sandbox).toEqual(defaultSandbox);
    expect(resolvedSandbox.mode).toBe("all");
    expect(resolvedSandbox.workspaceAccess).toBe("rw");
    expect(resolvedSandbox.docker.image).toBe("ghcr.io/openclaw/sandbox:custom");
    expect(resolvedSandbox.docker.network).toBe("none");
    expect(resolvedSandbox.docker.dangerouslyAllowContainerNamespaceJoin).toBe(true);
    expect(resolvedSandbox.docker.dangerouslyAllowExternalBindSources).toBe(true);
    expect(resolvedSandbox.browser.enabled).toBe(true);
    expect(resolvedSandbox.browser.image).toBe("ghcr.io/openclaw/browser:custom");
    expect(resolvedSandbox.browser.autoStart).toBe(false);
    expect(resolvedSandbox.prune.idleHours).toBe(1);
    expect(resolvedSandbox.prune.maxAgeDays).toBe(7);
  });
});

describe("resolveCronAgentConfig memory search preservation", () => {
  it("keeps global memory search defaults when the agent override is partial", () => {
    const defaultMemorySearch = {
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-large",
      sources: ["memory", "sessions"],
      remote: { apiKey: "redacted" },
      query: { maxResults: 6 },
    } satisfies MemorySearchConfig;
    const agentMemorySearch = {
      rememberAcrossConversations: true,
      query: { maxResults: 10 },
    } satisfies MemorySearchConfig;
    const { agentDefaults } = resolveCronAgentConfig({
      config: {},
      agentConfigOverride: { memory: { search: agentMemorySearch } },
    });
    const runCfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: agentDefaults,
        entries: { main: { memory: { search: agentMemorySearch } } },
      },
      memory: { search: defaultMemorySearch },
    };

    expect(agentDefaults).not.toHaveProperty("memory");
    expect(resolveMemorySearchConfig(runCfg, "main")).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-large",
      sources: ["memory", "sessions"],
      remote: { apiKey: "redacted" },
      rememberAcrossConversations: true,
      query: { maxResults: 10 },
    });
  });
});
