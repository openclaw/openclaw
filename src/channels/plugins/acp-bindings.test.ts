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
const binding = {
  type: "acp" as const,
  agentId: "codex",
  match: {
    channel: "discord",
    peer: { kind: "channel" as const, id: conversation.conversationId },
  },
};
function createConfig(options?: { accountId?: string; route?: boolean }): OpenClawConfig {
  const { type: _type, ...route } = binding;
  return {
    agents: { entries: { main: {}, codex: {} } },
    bindings: [
      {
        ...route,
        ...(!options?.route ? { type: binding.type, acp: { backend: "acpx" } } : {}),
        match: { ...binding.match, accountId: options?.accountId ?? "default" },
      },
    ],
  };
}
function publishPlugin(matches = true) {
  const plugin = {
    ...createChannelTestPluginBase({ id: "discord" }),
    bindings: {
      compileConfiguredBinding: vi.fn(({ conversationId }: { conversationId: string }) => ({
        conversationId,
      })),
      matchInboundConversation: (input: {
        compiledBinding: { conversationId: string };
        conversationId: string;
      }) =>
        matches && input.compiledBinding.conversationId === input.conversationId
          ? { conversationId: input.conversationId, matchPriority: 2 }
          : null,
    },
  };
  const registry = createEmptyPluginRegistry();
  registry.channels.push({ pluginId: "binding-fixture", plugin, source: import.meta.url });
  setActivePluginRegistry(registry);
  return plugin;
}
const resolveRecord = (cfg: OpenClawConfig) =>
  bindingRegistry.resolveConfiguredBindingRecord({ cfg, ...conversation });
beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => clearActivePluginRegistry());

it("resolves wildcard session keys from compiled bindings", () => {
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
it("does not discover an unavailable plugin late", () => {
  expect(resolveRecord(createConfig())).toBeNull();
});
it("skips route bindings without invoking the provider", () => {
  const plugin = publishPlugin();
  expect(resolveRecord(createConfig({ route: true }))).toBeNull();
  expect(plugin.bindings.compileConfiguredBinding).not.toHaveBeenCalled();
});
it("uses the current loaded channel plugin after replacement", () => {
  const cfg = createConfig();
  publishPlugin();
  expect(resolveRecord(cfg)).not.toBeNull();
  publishPlugin(false);
  expect(resolveRecord(cfg)).toBeNull();
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
  const materialized = resolveRecord({ ...cfg, bindings: [binding] });
  if (!materialized) {
    throw new Error("expected a configured ACP binding");
  }
  expect(resolveConfiguredAcpBindingSpecFromRecord(materialized.record)?.thinking).toBe(expected);
});
