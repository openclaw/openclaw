import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildConfiguredAcpSessionKey,
  resolveConfiguredAcpBindingSpecFromRecord,
} from "../../acp/persistent-bindings.types.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import * as bindingRegistry from "./configured-binding-registry.js";

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

const resolveRecord = (cfg: OpenClawConfig) =>
  bindingRegistry.resolveConfiguredBindingRecord({ cfg, ...conversation });

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

afterEach(() => clearActivePluginRegistry());

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
  expect(resolved?.statefulTarget).toEqual({
    kind: "stateful",
    driverId: "acp",
    sessionKey: resolved?.record.targetSessionKey,
    agentId: "codex",
    label: undefined,
  });
});

it("does not perform late plugin discovery when a channel plugin is unavailable", () => {
  expect(resolveRecord(createConfig())).toBeNull();
});

it("skips ordinary route bindings without invoking a configured binding provider", () => {
  const plugin = publishPlugin();
  expect(resolveRecord(createConfig({ route: true }))).toBeNull();
  expect(plugin.bindings.compileConfiguredBinding).not.toHaveBeenCalled();
});

it("uses the current loaded channel plugin on each resolve", () => {
  const firstPlugin = createDiscordAcpPlugin();
  const secondPlugin = createDiscordAcpPlugin();
  publishPlugin(firstPlugin);
  const cfg = createConfig();

  resolveRecord(cfg);

  publishPlugin(secondPlugin);
  resolveRecord(cfg);

  expect(firstPlugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
  expect(secondPlugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
});

const model = "ollama-cloud/glm-5.2:cloud";
function thinkingConfig(defaults: AgentDefaultsConfig, thinkingDefault?: "high"): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    agents: {
      entries: { codex: { model, ...(thinkingDefault ? { thinkingDefault } : {}) } },
      defaults,
    },
  };
}
const defaults = {
  thinkingDefault: "adaptive" as const,
  models: { [model]: { params: { thinking: "off" } } },
};

it.each([
  ["model beats global", thinkingConfig(defaults), "off"],
  ["agent beats model", thinkingConfig(defaults, "high"), "high"],
  ["global fallback", thinkingConfig({ thinkingDefault: "adaptive" }), "adaptive"],
  ["harness fallback", { agents: { entries: { codex: { model: undefined } } } }, undefined],
  [
    "global without model",
    { agents: { entries: { codex: {} }, defaults: { thinkingDefault: "off" } } },
    "off",
  ],
] as const)("configured ACP thinking: %s", (_name, cfg, expected) => {
  publishPlugin();
  const materialized = resolveRecord({
    ...cfg,
    bindings: [
      {
        type: "acp",
        agentId: "codex",
        match: {
          channel: "discord",
          peer: { kind: "channel", id: conversation.conversationId },
        },
      },
    ],
  });
  if (!materialized) {
    throw new Error("expected a configured ACP binding");
  }
  expect(resolveConfiguredAcpBindingSpecFromRecord(materialized.record)?.thinking).toBe(expected);
});
