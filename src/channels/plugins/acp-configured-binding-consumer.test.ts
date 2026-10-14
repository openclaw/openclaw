/** Tests configured ACP binding thinking-default precedence. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
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

afterEach(async () => {
  await clearActivePluginRegistry();
});

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

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    entries: { codex: { model: "ollama-cloud/glm-5.2:cloud" } },
    defaults: {
      thinkingDefault: "adaptive",
      models: {
        "ollama-cloud/glm-5.2:cloud": { params: { thinking: "off" } },
      },
    },
  },
} satisfies OpenClawConfig;

describe("configured ACP binding thinking precedence", () => {
  it("honors per-model params.thinking over the global default", () => {
    expect(materializeThinking(baseCfg)).toBe("off");
  });

  it("still lets an explicit per-agent thinkingDefault win over per-model policy", () => {
    const cfg = {
      ...baseCfg,
      agents: {
        ...baseCfg.agents,
        entries: { codex: { model: "ollama-cloud/glm-5.2:cloud", thinkingDefault: "high" } },
      },
    } satisfies OpenClawConfig;

    expect(materializeThinking(cfg)).toBe("high");
  });

  it("falls back to the global default when neither agent nor per-model policy is set", () => {
    const cfg = {
      ...baseCfg,
      agents: { ...baseCfg.agents, defaults: { thinkingDefault: "adaptive" } },
    } satisfies OpenClawConfig;

    expect(materializeThinking(cfg)).toBe("adaptive");
  });

  it.each([undefined])("leaves unconfigured thinking to the harness with model %s", (model) => {
    expect(materializeThinking({ agents: { entries: { codex: { model } } } })).toBeUndefined();
  });

  it("forwards global thinking without requiring a configured model", () => {
    expect(
      materializeThinking({
        agents: { entries: { codex: {} }, defaults: { thinkingDefault: "off" } },
      }),
    ).toBe("off");
  });
});
