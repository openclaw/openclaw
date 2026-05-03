import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const ensureOpenClawModelsJsonMock = vi.fn<
  (
    config: unknown,
    agentDir: unknown,
    options?: unknown,
  ) => Promise<{ agentDir: string; wrote: boolean }>
>(async () => ({ agentDir: "/tmp/agent", wrote: false }));
const piModelModuleLoadedMock = vi.fn();
const resolveEmbeddedAgentRuntimeMock = vi.fn(() => "auto");

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/agent",
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: (cfg: any) =>
    Array.isArray(cfg?.agents?.list) && cfg.agents.list.length > 0
      ? cfg.agents.list.map((entry: any) => entry.id)
      : ["main"],
  resolveAgentDir: (_cfg: unknown, agentId: unknown) =>
    agentId === "main" ? "/tmp/main/agent" : `/tmp/${String(agentId)}/agent`,
  resolveAgentEffectiveModelPrimary: (cfg: any, agentId: string) =>
    cfg?.agents?.list?.find((entry: any) => entry?.id === agentId)?.model?.primary ??
    cfg?.agents?.list?.find((entry: any) => entry?.id === agentId)?.model,
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: unknown) =>
    `/tmp/${String(agentId)}-workspace`,
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: (config: unknown, agentDir: unknown, options?: unknown) =>
    ensureOpenClawModelsJsonMock(config, agentDir, options),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => {
  piModelModuleLoadedMock();
  return {
    resolveModel: () => ({}),
  };
});

vi.mock("../agents/pi-embedded-runner/runtime.js", () => ({
  resolveEmbeddedAgentRuntime: () => resolveEmbeddedAgentRuntimeMock(),
}));

let refreshConfiguredAgentModelsJsonOnStartup: typeof import("./server-startup.js").__testing.refreshConfiguredAgentModelsJsonOnStartup;
let prewarmConfiguredPrimaryModel: typeof import("./server-startup.js").__testing.prewarmConfiguredPrimaryModel;
let shouldSkipStartupModelPrewarm: typeof import("./server-startup.js").__testing.shouldSkipStartupModelPrewarm;

describe("gateway startup primary model warmup", () => {
  beforeAll(async () => {
    ({
      __testing: {
        refreshConfiguredAgentModelsJsonOnStartup,
        prewarmConfiguredPrimaryModel,
        shouldSkipStartupModelPrewarm,
      },
    } = await import("./server-startup.js"));
  });

  beforeEach(() => {
    ensureOpenClawModelsJsonMock.mockClear();
    piModelModuleLoadedMock.mockClear();
    resolveEmbeddedAgentRuntimeMock.mockClear();
    resolveEmbeddedAgentRuntimeMock.mockReturnValue("auto");
  });

  it("prewarms an explicit configured primary model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/default-workspace",
        providerDiscoveryProviderIds: ["openai-codex"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(piModelModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("refreshes configured non-default agent dirs during startup", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
          },
        },
        list: [{ id: "zed" }, { id: "kim" }],
      },
    } as OpenClawConfig;

    await refreshConfiguredAgentModelsJsonOnStartup({
      cfg,
      workspaceDir: "/tmp/default-workspace",
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/default-workspace",
        providerDiscoveryProviderIds: ["openai-codex"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/zed/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/zed-workspace",
        providerDiscoveryProviderIds: ["openai-codex"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/kim/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/kim-workspace",
        providerDiscoveryProviderIds: ["openai-codex"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes configured custom agent dirs even without a default primary model", async () => {
    const cfg = {
      agents: {
        list: [{ id: "zed" }, { id: "kim" }],
      },
    } as OpenClawConfig;

    await refreshConfiguredAgentModelsJsonOnStartup({
      cfg,
      workspaceDir: "/tmp/default-workspace",
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/default-workspace",
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/zed/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/zed-workspace",
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/kim/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/kim-workspace",
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledTimes(3);
    expect(piModelModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("does not refresh the synthetic main agent separately when no agents are configured", async () => {
    const cfg = {} as OpenClawConfig;

    await refreshConfiguredAgentModelsJsonOnStartup({
      cfg,
      workspaceDir: "/tmp/default-workspace",
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledOnce();
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/default-workspace",
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalledWith(
      cfg,
      "/tmp/main/agent",
      expect.anything(),
    );
    expect(piModelModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("skips warmup when no explicit primary model is configured", async () => {
    await prewarmConfiguredPrimaryModel({
      cfg: {} as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(piModelModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("honors the startup model prewarm skip env", () => {
    expect(shouldSkipStartupModelPrewarm({})).toBe(false);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      }),
    ).toBe(true);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "true",
      }),
    ).toBe(true);
  });

  it("skips static warmup for configured CLI backends", async () => {
    await prewarmConfiguredPrimaryModel({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "codex-cli/gpt-5.5",
            },
            cliBackends: {
              "codex-cli": {
                command: "codex",
                args: ["exec"],
              },
            },
          },
        },
      } as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(piModelModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("skips static warmup when a non-PI agent runtime is forced", async () => {
    resolveEmbeddedAgentRuntimeMock.mockReturnValue("codex");
    await prewarmConfiguredPrimaryModel({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "codex/gpt-5.4",
            },
          },
        },
      } as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(piModelModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("keeps PI static warmup when the PI agent runtime is forced", async () => {
    resolveEmbeddedAgentRuntimeMock.mockReturnValue("pi");
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(
      cfg,
      "/tmp/agent",
      expect.objectContaining({
        workspaceDir: "/tmp/default-workspace",
        providerDiscoveryProviderIds: ["openai-codex"],
        providerDiscoveryTimeoutMs: 5000,
        providerDiscoveryEntriesOnly: true,
      }),
    );
    expect(piModelModuleLoadedMock).not.toHaveBeenCalled();
  });

  it("warns when scoped models.json preparation fails", async () => {
    ensureOpenClawModelsJsonMock.mockRejectedValueOnce(new Error("models write failed"));
    const warn = vi.fn();

    await prewarmConfiguredPrimaryModel({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "codex/gpt-5.4",
            },
          },
        },
      } as OpenClawConfig,
      log: { warn },
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("startup model warmup failed for codex/gpt-5.4"),
    );
  });
});
