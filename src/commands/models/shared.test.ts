import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn(),
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultModelForAgent: vi.fn(
    ({ cfg, agentId }: { cfg: OpenClawConfig; agentId: string }) => {
      const raw =
        agentId === "main"
          ? cfg.agents?.defaults?.model
          : (cfg.agents?.list?.find((entry) => entry.id === agentId)?.model ??
            cfg.agents?.defaults?.model);
      const primary =
        typeof raw === "string"
          ? raw
          : raw && typeof raw === "object" && typeof raw.primary === "string"
            ? raw.primary
            : "anthropic/claude-opus-4-5";
      const slash = primary.indexOf("/");
      return slash > 0
        ? {
            provider: primary.slice(0, slash),
            model: primary.slice(slash + 1),
          }
        : { provider: "anthropic", model: primary };
    },
  ),
  resolveStorePath: vi.fn((_: unknown, { agentId }: { agentId: string }) => `/tmp/${agentId}.json`),
  updateSessionStore: vi.fn(
    async (
      _storePath: string,
      updater: (store: Record<string, Record<string, unknown>>) => unknown,
    ) => {
      const store = {
        "agent:main:main": {
          sessionId: "s1",
          updatedAt: 1,
          modelProvider: "openai-codex",
          model: "gpt-5.3-codex",
          fallbackNoticeSelectedModel: "openai-codex/gpt-5.3-codex",
          fallbackNoticeActiveModel: "openai-codex/gpt-5.3-codex",
          fallbackNoticeReason: "provider fallback",
        },
        "agent:main:kept": {
          sessionId: "s2",
          updatedAt: 1,
          providerOverride: "openai",
          modelOverride: "gpt-5.2",
          modelProvider: "openai",
          model: "gpt-5.2",
        },
      };
      return await updater(store);
    },
  ),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    listAgentIds: mocks.listAgentIds,
  };
});

vi.mock("../../agents/model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-selection.js")>();
  return {
    ...actual,
    resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
  };
});

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: mocks.resolveStorePath,
    updateSessionStore: mocks.updateSessionStore,
  };
});

import {
  loadValidConfigOrThrow,
  syncSessionStoresForDefaultModelChange,
  updateConfig,
} from "./shared.js";

describe("models/shared", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.writeConfigFile.mockClear();
    mocks.listAgentIds.mockReset();
    mocks.listAgentIds.mockReturnValue(["main"]);
    mocks.resolveDefaultModelForAgent.mockClear();
    mocks.resolveStorePath.mockClear();
    mocks.updateSessionStore.mockClear();
  });

  it("returns config when snapshot is valid", async () => {
    const cfg = { providers: {} } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: cfg,
    });

    await expect(loadValidConfigOrThrow()).resolves.toBe(cfg);
  });

  it("throws formatted issues when snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: false,
      path: "/tmp/openclaw.json",
      issues: [{ path: "providers.openai.apiKey", message: "Required" }],
    });

    await expect(loadValidConfigOrThrow()).rejects.toThrowError(
      "Invalid config at /tmp/openclaw.json\n- providers.openai.apiKey: Required",
    );
  });

  it("updateConfig writes mutated config", async () => {
    const cfg = { update: { channel: "stable" } } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: cfg,
    });
    mocks.writeConfigFile.mockResolvedValue(undefined);

    await updateConfig((current) => ({
      ...current,
      update: { channel: "beta" },
    }));

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { channel: "beta" },
      }),
    );
  });

  it("syncs session runtime snapshots when an agent default model changes", async () => {
    const previousConfig = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.3-codex" },
        },
      },
    } as unknown as OpenClawConfig;
    const nextConfig = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.4" },
        },
      },
    } as unknown as OpenClawConfig;

    await syncSessionStoresForDefaultModelChange({
      previousConfig,
      nextConfig,
    });

    expect(mocks.updateSessionStore).toHaveBeenCalledWith("/tmp/main.json", expect.any(Function));
    const updater = mocks.updateSessionStore.mock.calls[0]?.[1];
    const store = {
      "agent:main:main": {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.3-codex",
        fallbackNoticeSelectedModel: "openai-codex/gpt-5.3-codex",
        fallbackNoticeActiveModel: "openai-codex/gpt-5.3-codex",
        fallbackNoticeReason: "provider fallback",
      },
      "agent:main:kept": {
        sessionId: "s2",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.2",
        modelProvider: "openai",
        model: "gpt-5.2",
      },
    };

    updater(store);

    expect(store["agent:main:main"]).toMatchObject({
      sessionId: "s1",
    });
    expect(store["agent:main:main"].modelProvider).toBeUndefined();
    expect(store["agent:main:main"].model).toBeUndefined();
    expect(store["agent:main:main"].fallbackNoticeSelectedModel).toBeUndefined();
    expect(store["agent:main:main"].fallbackNoticeActiveModel).toBeUndefined();
    expect(store["agent:main:main"].fallbackNoticeReason).toBeUndefined();
    expect(store["agent:main:kept"]).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.2",
      modelProvider: "openai",
      model: "gpt-5.2",
    });
  });

  it("skips session sync when the effective defaults do not change", async () => {
    const previousConfig = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.4" },
        },
      },
    } as unknown as OpenClawConfig;
    const nextConfig = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.4" },
        },
      },
    } as unknown as OpenClawConfig;

    await syncSessionStoresForDefaultModelChange({
      previousConfig,
      nextConfig,
    });

    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });
});
