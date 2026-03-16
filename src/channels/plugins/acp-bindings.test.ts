import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentConfigMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const loadOpenClawPluginsMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryKeyMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: (...args: unknown[]) => resolveAgentConfigMock(...args),
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
}));

vi.mock("./index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  getActivePluginRegistryKey: (...args: unknown[]) => getActivePluginRegistryKeyMock(...args),
}));

import { importFreshModule } from "../../../test/helpers/import-fresh.js";

async function importAcpBindings(scope: string) {
  return await importFreshModule<typeof import("./acp-bindings.js")>(
    import.meta.url,
    `./acp-bindings.js?scope=${scope}`,
  );
}

function createConfig() {
  return {
    agents: {
      list: [{ id: "codex" }],
    },
    bindings: [
      {
        type: "acp",
        agentId: "codex",
        match: {
          channel: "discord",
          accountId: "default",
          peer: {
            kind: "channel",
            id: "1479098716916023408",
          },
        },
        acp: {
          backend: "acpx",
        },
      },
    ],
  };
}

function createDiscordAcpPlugin() {
  return {
    id: "discord",
    acpBindings: {
      normalizeConfiguredBindingTarget: ({ conversationId }: { conversationId: string }) => ({
        conversationId,
      }),
      matchConfiguredBinding: ({
        bindingConversationId,
        conversationId,
        parentConversationId,
      }: {
        bindingConversationId: string;
        conversationId: string;
        parentConversationId?: string;
      }) => {
        if (bindingConversationId === conversationId) {
          return { conversationId, matchPriority: 2 };
        }
        if (parentConversationId && bindingConversationId === parentConversationId) {
          return { conversationId: parentConversationId, matchPriority: 1 };
        }
        return null;
      },
    },
  };
}

describe("plugin ACP binding resolution", () => {
  beforeEach(() => {
    resolveAgentConfigMock.mockReset().mockReturnValue(undefined);
    resolveDefaultAgentIdMock.mockReset().mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReset().mockReturnValue("/tmp/workspace");
    getChannelPluginMock.mockReset();
    applyPluginAutoEnableMock.mockReset().mockReturnValue({ config: { autoEnabled: true } });
    loadOpenClawPluginsMock.mockReset();
    getActivePluginRegistryMock.mockReset().mockReturnValue({ channels: [] });
    getActivePluginRegistryKeyMock.mockReset().mockReturnValue("registry-key");
  });

  it("resolves configured ACP bindings from an already loaded channel plugin", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);
    const acpBindings = await importAcpBindings("loaded-plugin");

    const resolved = acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: createConfig() as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved?.spec.channel).toBe("discord");
    expect(resolved?.spec.backend).toBe("acpx");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("bootstraps channel plugins before resolving configured ACP bindings", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(plugin);
    const acpBindings = await importAcpBindings("bootstrap-plugin");

    const resolved = acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: createConfig() as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:discord:default:");
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith({
      config: { autoEnabled: true },
      workspaceDir: "/tmp/workspace",
    });
  });
});
