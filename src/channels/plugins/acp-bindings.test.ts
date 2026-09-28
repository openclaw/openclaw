// ACP binding tests cover channel plugin ACP target binding and stateful driver behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { ensureConfiguredBindingBuiltinsRegistered } from "./configured-binding-builtins.js";
import * as bindingRegistry from "./configured-binding-registry.js";

const resolveAgentConfigMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentConfig: resolveAgentConfigMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
}));

function createConfig(options?: { bindingAgentId?: string; accountId?: string }): OpenClawConfig {
  return {
    agents: {
      entries: { main: {}, codex: {} },
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

function createDiscordAcpPlugin() {
  const compileConfiguredBinding = vi.fn(({ conversationId }: { conversationId: string }) => ({
    conversationId,
  }));
  const matchInboundConversation = vi.fn(
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
    ...createChannelTestPluginBase({ id: "discord" }),
    bindings: {
      compileConfiguredBinding,
      matchInboundConversation,
    },
  };
}

function publishPlugin(plugin?: ReturnType<typeof createDiscordAcpPlugin>) {
  const registry = createEmptyPluginRegistry();
  if (plugin) {
    registry.channels.push({ pluginId: "binding-fixture", plugin, source: import.meta.url });
  }
  setActivePluginRegistry(registry);
}

describe("configured binding registry", () => {
  beforeEach(() => {
    resolveAgentConfigMock.mockReset().mockReturnValue(undefined);
    resolveDefaultAgentIdMock.mockReset().mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReset().mockReturnValue("/tmp/workspace");
    publishPlugin();
    ensureConfiguredBindingBuiltinsRegistered();
  });

  afterEach(async () => {
    await clearActivePluginRegistry();
  });

  it("resolves configured ACP bindings from an already loaded channel plugin", () => {
    const plugin = createDiscordAcpPlugin();
    publishPlugin(plugin);

    const resolved = bindingRegistry.resolveConfiguredBindingRecord({
      cfg: createConfig(),
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.record.metadata?.backend).toBe("acpx");
    expect(plugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
  });

  it("resolves configured ACP bindings from canonical conversation refs", () => {
    const plugin = createDiscordAcpPlugin();
    publishPlugin(plugin);

    const resolved = bindingRegistry.resolveConfiguredBinding({
      cfg: createConfig(),
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
    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.statefulTarget).toEqual({
      kind: "stateful",
      driverId: "acp",
      sessionKey: resolved?.record.targetSessionKey,
      agentId: "codex",
      label: undefined,
    });
  });

  it("resolves wildcard binding session keys from the compiled registry", () => {
    const plugin = createDiscordAcpPlugin();
    publishPlugin(plugin);

    const resolved = bindingRegistry.resolveConfiguredBindingRecordBySessionKey({
      cfg: createConfig({ accountId: "*" }),
      sessionKey: buildConfiguredAcpSessionKey({
        channel: "discord",
        accountId: "work",
        conversationId: "1479098716916023408",
        agentId: "codex",
        mode: "persistent",
        backend: "acpx",
      }),
    });

    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.record.conversation.accountId).toBe("work");
    expect(resolved?.record.metadata?.backend).toBe("acpx");
  });

  it("does not perform late plugin discovery when a channel plugin is unavailable", () => {
    const resolved = bindingRegistry.resolveConfiguredBindingRecord({
      cfg: createConfig(),
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved).toBeNull();
  });

  it("skips ordinary route bindings without invoking a configured binding provider", () => {
    const plugin = createDiscordAcpPlugin();
    publishPlugin(plugin);
    const cfg: OpenClawConfig = {
      ...createConfig(),
      bindings: [
        {
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: {
              kind: "channel",
              id: "1479098716916023408",
            },
          },
        },
      ],
    };

    expect(
      bindingRegistry.resolveConfiguredBindingRecord({
        cfg,
        channel: "discord",
        accountId: "default",
        conversationId: "1479098716916023408",
      }),
    ).toBeNull();
    expect(plugin.bindings.compileConfiguredBinding).not.toHaveBeenCalled();
  });

  it("uses the current loaded channel plugin on each resolve", () => {
    const firstPlugin = createDiscordAcpPlugin();
    const secondPlugin = createDiscordAcpPlugin();
    publishPlugin(firstPlugin);
    const cfg = createConfig();

    bindingRegistry.resolveConfiguredBindingRecord({
      cfg,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    publishPlugin(secondPlugin);
    bindingRegistry.resolveConfiguredBindingRecord({
      cfg,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(firstPlugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
    expect(secondPlugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
  });
});
