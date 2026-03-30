import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const ensureOpenClawModelsJsonMock = vi.fn<
  (config: unknown, agentDir: unknown) => Promise<{ agentDir: string; wrote: boolean }>
>(async () => ({ agentDir: "/tmp/agent", wrote: false }));
const resolveModelMock = vi.fn<
  (
    provider: unknown,
    modelId: unknown,
    agentDir: unknown,
    cfg: unknown,
    options?: unknown,
  ) => { model: { id: string; provider: string; api: string } }
>(() => ({
  model: {
    id: "gpt-5.4",
    provider: "openai-codex",
    api: "openai-codex-responses",
  },
}));
const resolveAgentSessionDirsMock = vi.fn<(stateDir: unknown) => Promise<string[]>>();
const applyConfiguredSessionUsageCacheSettingsMock = vi.fn<(cfg: unknown) => void>();

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/agent",
}));

vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: (stateDir: unknown) => resolveAgentSessionDirsMock(stateDir),
  cleanStaleLockFiles: vi.fn(async () => {}),
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson: (config: unknown, agentDir: unknown) =>
    ensureOpenClawModelsJsonMock(config, agentDir),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: (
    provider: unknown,
    modelId: unknown,
    agentDir: unknown,
    cfg: unknown,
    options?: unknown,
  ) => resolveModelMock(provider, modelId, agentDir, cfg, options),
}));

vi.mock("./session-utils.fs.js", async () => {
  const actual =
    await vi.importActual<typeof import("./session-utils.fs.js")>("./session-utils.fs.js");
  return {
    ...actual,
    applyConfiguredSessionUsageCacheSettings: (cfg: unknown) =>
      applyConfiguredSessionUsageCacheSettingsMock(cfg),
  };
});

describe("gateway startup primary model warmup", () => {
  beforeEach(() => {
    ensureOpenClawModelsJsonMock.mockClear();
    resolveModelMock.mockClear();
    resolveAgentSessionDirsMock.mockReset();
    resolveAgentSessionDirsMock.mockResolvedValue([]);
    applyConfiguredSessionUsageCacheSettingsMock.mockClear();
  });

  it("prewarms an explicit configured primary model", async () => {
    const { __testing } = await import("./server-startup.js");
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await __testing.prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalledWith(cfg, "/tmp/agent");
    expect(resolveModelMock).toHaveBeenCalledWith("openai-codex", "gpt-5.4", "/tmp/agent", cfg, {
      skipProviderRuntimeHooks: true,
    });
  });

  it("skips warmup when no explicit primary model is configured", async () => {
    const { __testing } = await import("./server-startup.js");

    await __testing.prewarmConfiguredPrimaryModel({
      cfg: {} as OpenClawConfig,
      log: { warn: vi.fn() },
    });

    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it("reapplies sessions.list cache settings before the first awaited startup work", async () => {
    let release!: () => void;
    const blocked = new Promise<string[]>((resolve) => {
      release = () => resolve([]);
    });
    resolveAgentSessionDirsMock.mockReturnValueOnce(blocked);

    const { startGatewaySidecars } = await import("./server-startup.js");
    const cfg = {
      gateway: {
        sessionsList: {
          usageCacheMaxEntries: 123,
        },
      },
    } as OpenClawConfig;

    const promise = startGatewaySidecars({
      cfg,
      pluginRegistry: new Map() as never,
      defaultWorkspaceDir: "/tmp/workspace",
      deps: {} as never,
      startChannels: vi.fn(async () => {}),
      log: { info: vi.fn(), warn: vi.fn() },
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
    });

    expect(applyConfiguredSessionUsageCacheSettingsMock).toHaveBeenCalledWith(cfg);

    release();
    await promise;
  });
});
