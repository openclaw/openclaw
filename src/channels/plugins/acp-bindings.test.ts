import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
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

const conversation = {
  channel: "discord",
  accountId: "default",
  conversationId: "1479098716916023408",
};

function createConfig(options?: { accountId?: string; route?: boolean }): OpenClawConfig {
  return {
    agents: { entries: { main: {}, codex: {} } },
    bindings: [
      {
        ...(!options?.route ? { type: "acp" as const, acp: { backend: "acpx" } } : {}),
        agentId: "codex",
        match: {
          channel: "discord",
          accountId: options?.accountId ?? "default",
          peer: { kind: "channel", id: conversation.conversationId },
        },
      },
    ],
  };
}

function createDiscordAcpPlugin() {
  return {
    ...createChannelTestPluginBase({ id: "discord" }),
    bindings: {
      compileConfiguredBinding: vi.fn(({ conversationId }: { conversationId: string }) => ({
        conversationId,
      })),
      matchInboundConversation: vi.fn(
        (input: { compiledBinding: { conversationId: string }; conversationId: string }) =>
          input.compiledBinding.conversationId === input.conversationId
            ? { conversationId: input.conversationId, matchPriority: 2 }
            : null,
      ),
    },
  };
}

function publishPlugin(plugin = createDiscordAcpPlugin()) {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({ pluginId: "binding-fixture", plugin, source: import.meta.url });
  setActivePluginRegistry(registry);
  return plugin;
}

beforeEach(() => {
  resolveAgentConfigMock.mockReset().mockReturnValue(undefined);
  resolveDefaultAgentIdMock.mockReset().mockReturnValue("main");
  resolveAgentWorkspaceDirMock.mockReset().mockReturnValue("/tmp/workspace");
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => clearActivePluginRegistry());

it("resolves configured ACP bindings from canonical conversation refs", () => {
  publishPlugin();

  const resolved = bindingRegistry.resolveConfiguredBinding({
    cfg: createConfig(),
    conversation,
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
  publishPlugin();

  const resolved = bindingRegistry.resolveConfiguredBindingRecordBySessionKey({
    cfg: createConfig({ accountId: "*" }),
    sessionKey: buildConfiguredAcpSessionKey({
      ...conversation,
      accountId: "work",
      agentId: "codex",
      mode: "persistent",
      backend: "acpx",
    }),
  });

  expect(resolved?.record).toMatchObject({
    conversation: { channel: "discord", accountId: "work" },
    metadata: { backend: "acpx" },
  });
});

it("does not perform late plugin discovery when a channel plugin is unavailable", () => {
  const resolved = bindingRegistry.resolveConfiguredBindingRecord({
    cfg: createConfig(),
    ...conversation,
  });

  expect(resolved).toBeNull();
});

it("skips ordinary route bindings without invoking a configured binding provider", () => {
  const plugin = publishPlugin();
  expect(
    bindingRegistry.resolveConfiguredBindingRecord({
      cfg: createConfig({ route: true }),
      ...conversation,
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
    ...conversation,
  });

  publishPlugin(secondPlugin);
  bindingRegistry.resolveConfiguredBindingRecord({
    cfg,
    ...conversation,
  });

  expect(firstPlugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
  expect(secondPlugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
});
