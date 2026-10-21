import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { AgentAcpBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { resolveConfiguredBindingRecord } from "./configured-binding-registry.js";

const binding: AgentAcpBinding = {
  type: "acp",
  agentId: "codex",
  match: { channel: "discord", peer: { kind: "channel", id: "convo-1" } },
};

beforeEach(() => {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({
    pluginId: "binding-fixture",
    source: import.meta.url,
    plugin: {
      ...createChannelTestPluginBase({ id: "discord" }),
      bindings: {
        compileConfiguredBinding: ({ conversationId }) => ({ conversationId }),
        matchInboundConversation: ({ conversationId }) => ({ conversationId }),
      },
    },
  });
  setActivePluginRegistry(registry);
});

afterEach(() => clearActivePluginRegistry());

function materializeThinking(cfg: OpenClawConfig): string | undefined {
  const materialized = resolveConfiguredBindingRecord({
    cfg: { ...cfg, bindings: [binding] },
    channel: "discord",
    accountId: "default",
    conversationId: "convo-1",
  });
  if (!materialized) {
    throw new Error("expected a configured ACP binding");
  }
  return resolveConfiguredAcpBindingSpecFromRecord(materialized.record)?.thinking;
}

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
  expect(materializeThinking(cfg)).toBe(expected);
});
