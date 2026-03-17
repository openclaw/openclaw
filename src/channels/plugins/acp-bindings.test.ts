import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../../acp/persistent-bindings.types.js";

const resolveAgentConfigMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const loadOpenClawPluginsMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());

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
}));

import { importFreshModule } from "../../../test/helpers/import-fresh.js";

async function importAcpBindings(scope: string) {
  return await importFreshModule<typeof import("./acp-bindings.js")>(
    import.meta.url,
    `./acp-bindings.js?scope=${scope}`,
  );
}

function createConfig(options?: { bindingAgentId?: string }) {
  return {
    agents: {
      list: [{ id: "main" }, { id: "codex" }],
    },
    bindings: [
      {
        type: "acp",
        agentId: options?.bindingAgentId ?? "codex",
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
    applyPluginAutoEnableMock.mockReset().mockImplementation(({ config }: { config: unknown }) => ({
      config,
    }));
    loadOpenClawPluginsMock.mockReset();
    getActivePluginRegistryMock.mockReset().mockReturnValue({ channels: [] });
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

  it("loads channel plugin snapshots before resolving configured ACP bindings", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(undefined);
    loadOpenClawPluginsMock.mockReturnValue({
      channels: [{ plugin }],
    });
    const acpBindings = await importAcpBindings("bootstrap-plugin");

    const resolved = acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: createConfig() as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:discord:default:");
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith({
      activate: false,
      cache: false,
      config: createConfig(),
      includeSetupOnlyChannelPlugins: true,
      onlyPluginIds: ["discord"],
      preferSetupRuntimeForChannelPlugins: true,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
      workspaceDir: "/tmp/workspace",
    });
  });

  it("loads configured binding channel plugins from the binding agent workspace", async () => {
    const plugin = createDiscordAcpPlugin();
    const cfg = createConfig({ bindingAgentId: "codex" });
    getChannelPluginMock.mockReturnValue(undefined);
    resolveAgentWorkspaceDirMock.mockImplementation((_cfg: unknown, agentId: string) =>
      agentId === "codex" ? "/tmp/codex" : "/tmp/main",
    );
    loadOpenClawPluginsMock.mockImplementation(({ workspaceDir }: { workspaceDir?: string }) =>
      workspaceDir === "/tmp/codex" ? { channels: [{ plugin }] } : { channels: [] },
    );
    const acpBindings = await importAcpBindings("binding-workspace");

    const resolved = acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved?.spec.agentId).toBe("codex");
    expect(loadOpenClawPluginsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceDir: "/tmp/main",
        onlyPluginIds: ["discord"],
      }),
    );
    expect(loadOpenClawPluginsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceDir: "/tmp/codex",
        onlyPluginIds: ["discord"],
      }),
    );
  });

  it("resolves configured ACP session keys from binding agent plugin snapshots", async () => {
    const plugin = createDiscordAcpPlugin();
    const cfg = createConfig({ bindingAgentId: "codex" });
    getChannelPluginMock.mockReturnValue(undefined);
    resolveAgentWorkspaceDirMock.mockImplementation((_cfg: unknown, agentId: string) =>
      agentId === "codex" ? "/tmp/codex" : "/tmp/main",
    );
    loadOpenClawPluginsMock.mockImplementation(({ workspaceDir }: { workspaceDir?: string }) =>
      workspaceDir === "/tmp/codex" ? { channels: [{ plugin }] } : { channels: [] },
    );
    const acpBindings = await importAcpBindings("binding-session-key");

    const sessionKey = buildConfiguredAcpSessionKey({
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
      agentId: "codex",
      acpAgentId: undefined,
      mode: "persistent",
      backend: "acpx",
      cwd: undefined,
      label: undefined,
    });

    const resolved = acpBindings.resolveConfiguredAcpBindingSpecBySessionKey({
      cfg: cfg as never,
      sessionKey,
    });

    expect(resolved?.channel).toBe("discord");
    expect(resolved?.agentId).toBe("codex");
    expect(loadOpenClawPluginsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceDir: "/tmp/main",
      }),
    );
    expect(loadOpenClawPluginsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceDir: "/tmp/codex",
      }),
    );
  });
});
