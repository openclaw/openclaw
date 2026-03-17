import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../../acp/persistent-bindings.types.js";

const resolveAgentConfigMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const getChannelPluginCatalogEntryMock = vi.hoisted(() => vi.fn());
const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const loadOpenClawPluginsMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryVersionMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: (...args: unknown[]) => resolveAgentConfigMock(...args),
  resolveDefaultAgentId: (...args: unknown[]) => resolveDefaultAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
}));

vi.mock("./index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("./catalog.js", () => ({
  getChannelPluginCatalogEntry: (...args: unknown[]) => getChannelPluginCatalogEntryMock(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  getActivePluginRegistryVersion: (...args: unknown[]) =>
    getActivePluginRegistryVersionMock(...args),
}));

import { importFreshModule } from "../../../test/helpers/import-fresh.js";

async function importAcpBindings(scope: string) {
  return await importFreshModule<typeof import("./acp-bindings.js")>(
    import.meta.url,
    `./acp-bindings.js?scope=${scope}`,
  );
}

function createConfig(options?: { bindingAgentId?: string; accountId?: string }) {
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
          accountId: options?.accountId ?? "default",
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

function createDiscordAcpPlugin(overrides?: {
  compileConfiguredBinding?: ReturnType<typeof vi.fn>;
  matchInboundConversation?: ReturnType<typeof vi.fn>;
}) {
  const compileConfiguredBinding =
    overrides?.compileConfiguredBinding ??
    vi.fn(({ conversationId }: { conversationId: string }) => ({
      conversationId,
    }));
  const matchInboundConversation =
    overrides?.matchInboundConversation ??
    vi.fn(
      ({
        compiledBinding,
        conversationId,
        parentConversationId,
      }: {
        compiledBinding: { conversationId: string };
        conversationId: string;
        parentConversationId?: string;
      }) => {
        if (compiledBinding.conversationId === conversationId) {
          return { conversationId, matchPriority: 2 };
        }
        if (parentConversationId && compiledBinding.conversationId === parentConversationId) {
          return { conversationId: parentConversationId, matchPriority: 1 };
        }
        return null;
      },
    );
  return {
    id: "discord",
    acpBindings: {
      compileConfiguredBinding,
      matchInboundConversation,
    },
  };
}

describe("plugin ACP binding registry", () => {
  beforeEach(() => {
    resolveAgentConfigMock.mockReset().mockReturnValue(undefined);
    resolveDefaultAgentIdMock.mockReset().mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReset().mockReturnValue("/tmp/workspace");
    getChannelPluginMock.mockReset();
    getChannelPluginCatalogEntryMock.mockReset().mockReturnValue(undefined);
    applyPluginAutoEnableMock.mockReset().mockImplementation(({ config }: { config: unknown }) => ({
      config,
    }));
    loadOpenClawPluginsMock.mockReset();
    getActivePluginRegistryMock.mockReset().mockReturnValue({ channels: [] });
    getActivePluginRegistryVersionMock.mockReset().mockReturnValue(1);
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
    expect(plugin.acpBindings.compileConfiguredBinding).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("resolves configured ACP bindings from canonical conversation refs", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);
    const acpBindings = await importAcpBindings("conversation-ref");

    const resolved = acpBindings.resolveConfiguredAcpBinding({
      cfg: createConfig() as never,
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "1479098716916023408",
      },
    });

    expect(resolved?.conversation).toEqual({
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });
    expect(resolved?.configuredBinding.spec.channel).toBe("discord");
  });

  it("primes compiled ACP bindings from the binding agent workspace once", async () => {
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

    const primed = acpBindings.primeConfiguredAcpBindingRegistry({
      cfg: cfg as never,
    });
    const resolved = acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(primed).toEqual({ bindingCount: 1, channelCount: 1 });
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
    loadOpenClawPluginsMock.mockClear();

    const second = acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(second?.spec.agentId).toBe("codex");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("resolves wildcard binding session keys from the compiled registry", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);
    const acpBindings = await importAcpBindings("wildcard-session-key");

    const spec = acpBindings.resolveConfiguredAcpBindingSpecBySessionKey({
      cfg: createConfig({ accountId: "*" }) as never,
      sessionKey: buildConfiguredAcpSessionKey({
        channel: "discord",
        accountId: "work",
        conversationId: "1479098716916023408",
        agentId: "codex",
        mode: "persistent",
        backend: "acpx",
      }),
    });

    expect(spec?.channel).toBe("discord");
    expect(spec?.accountId).toBe("work");
    expect(spec?.backend).toBe("acpx");
  });

  it("uses catalog plugin ids when they differ from the channel id", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(undefined);
    getChannelPluginCatalogEntryMock.mockReturnValue({
      id: "discord",
      pluginId: "@vendor/discord-runtime",
    });
    loadOpenClawPluginsMock.mockReturnValue({
      channels: [{ plugin }],
    });
    const acpBindings = await importAcpBindings("plugin-id-scope");

    const resolved = acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: createConfig() as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved?.spec.channel).toBe("discord");
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["@vendor/discord-runtime", "discord"],
      }),
    );
  });

  it("rebuilds the compiled registry when the active plugin registry version changes", async () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);
    getActivePluginRegistryVersionMock.mockReturnValue(10);
    const cfg = createConfig();
    const acpBindings = await importAcpBindings("registry-version");

    acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });
    acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    getActivePluginRegistryVersionMock.mockReturnValue(11);
    acpBindings.resolveConfiguredAcpBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(plugin.acpBindings.compileConfiguredBinding).toHaveBeenCalledTimes(2);
  });
});
