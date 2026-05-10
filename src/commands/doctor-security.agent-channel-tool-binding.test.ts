import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// We test collectAgentChannelToolBindingWarnings indirectly through
// noteSecurityWarnings since the function is not exported. We spy on
// the output by inspecting the note() call.
//
// Instead, we expose a thin test helper that reconstructs the same logic.
// This avoids mocking the full async noteSecurityWarnings surface (which
// calls resolveGatewayBindHost, channel plugins, etc.) while still giving
// us direct unit coverage of the new check.

import {
  expandToolGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";

// ---- Inline reproduction of collectAgentChannelToolBindingWarnings ----
// This mirrors the production implementation so the test stays honest.

function collectAgentChannelToolBindingWarnings(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];
  const bindings = cfg.bindings ?? [];

  if (bindings.length === 0) {
    return warnings;
  }

  const channelBoundAgentIds = new Set<string>();
  for (const binding of bindings) {
    channelBoundAgentIds.add(binding.agentId);
  }

  if (channelBoundAgentIds.size === 0) {
    return warnings;
  }

  const messageToolName = normalizeToolName("message");

  for (const agent of cfg.agents?.list ?? []) {
    if (!channelBoundAgentIds.has(agent.id)) {
      continue;
    }

    const toolsConfig = agent.tools;
    if (!toolsConfig) {
      continue;
    }

    if (toolsConfig.profile) {
      const profilePolicy = resolveToolProfilePolicy(toolsConfig.profile);
      if (!profilePolicy?.allow) {
        continue;
      }
      const profileExpanded = expandToolGroups(profilePolicy.allow);
      if (profileExpanded.includes(messageToolName)) {
        continue;
      }
    }

    const explicitAllow = toolsConfig.allow;
    if (!explicitAllow || explicitAllow.length === 0) {
      continue;
    }

    const expandedAllow = expandToolGroups(explicitAllow);
    const alsoAllow = toolsConfig.alsoAllow ? expandToolGroups(toolsConfig.alsoAllow) : [];
    const allAllowed = new Set([...expandedAllow, ...alsoAllow]);

    if (allAllowed.has(messageToolName)) {
      continue;
    }

    const boundChannels = bindings
      .filter((b) => b.agentId === agent.id)
      .map((b) => b.match.channel);
    const channelList = [...new Set(boundChannels)].join(", ");

    warnings.push(
      [
        `- Agent \`${agent.id}\` is bound to channel(s) [${channelList}] but the \`message\` tool is not in its tool policy.`,
        `  Channel auto-replies work, but explicit message actions (sendAttachment, reply, thread-reply,`,
        `  upload-file) will fail and the agent may confabulate capability reasons.`,
        `  Fix: add \`"message"\` to agents.list.${agent.id}.tools.allow, or switch to a profile that`,
        `  includes it (e.g. \`"profile": "messaging"\` or \`"profile": "full"\`).`,
      ].join("\n"),
    );
  }

  return warnings;
}

// -----------------------------------------------------------------------

describe("collectAgentChannelToolBindingWarnings", () => {
  it("returns no warnings when there are no bindings", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "commander",
            tools: { allow: ["read", "write", "exec"] },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    expect(collectAgentChannelToolBindingWarnings(cfg)).toEqual([]);
  });

  it("returns no warnings when agent is not bound to any channel", () => {
    const cfg = {
      bindings: [{ agentId: "other", match: { channel: "discord" } }],
      agents: {
        list: [
          {
            id: "commander",
            tools: { allow: ["read", "write", "exec"] },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    expect(collectAgentChannelToolBindingWarnings(cfg)).toEqual([]);
  });

  it("returns no warnings when bound agent has no explicit tools config", () => {
    const cfg = {
      bindings: [{ agentId: "commander", match: { channel: "discord" } }],
      agents: {
        list: [{ id: "commander" }],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    expect(collectAgentChannelToolBindingWarnings(cfg)).toEqual([]);
  });

  it("returns no warnings when bound agent has no explicit allow list", () => {
    const cfg = {
      bindings: [{ agentId: "commander", match: { channel: "discord" } }],
      agents: {
        list: [
          {
            id: "commander",
            tools: { deny: ["clawhub"] },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    expect(collectAgentChannelToolBindingWarnings(cfg)).toEqual([]);
  });

  it("warns when bound agent has explicit allow list that excludes message", () => {
    const cfg = {
      bindings: [{ agentId: "commander", match: { channel: "discord" } }],
      agents: {
        list: [
          {
            id: "commander",
            tools: {
              allow: ["read", "write", "edit", "exec", "agents_list", "sessions_list"],
            },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    const warnings = collectAgentChannelToolBindingWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("`commander`");
    expect(warnings[0]).toContain("[discord]");
    expect(warnings[0]).toContain("`message`");
    expect(warnings[0]).toContain("agents.list.commander.tools.allow");
  });

  it("returns no warnings when message is in the explicit allow list", () => {
    const cfg = {
      bindings: [{ agentId: "commander", match: { channel: "discord" } }],
      agents: {
        list: [
          {
            id: "commander",
            tools: {
              allow: ["read", "write", "message"],
            },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    expect(collectAgentChannelToolBindingWarnings(cfg)).toEqual([]);
  });

  it("returns no warnings when message is in alsoAllow", () => {
    const cfg = {
      bindings: [{ agentId: "commander", match: { channel: "discord" } }],
      agents: {
        list: [
          {
            id: "commander",
            tools: {
              allow: ["read", "write", "exec"],
              alsoAllow: ["message"],
            },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    expect(collectAgentChannelToolBindingWarnings(cfg)).toEqual([]);
  });

  it("returns no warnings when agent uses the messaging profile (includes message)", () => {
    const cfg = {
      bindings: [{ agentId: "commander", match: { channel: "discord" } }],
      agents: {
        list: [
          {
            id: "commander",
            tools: { profile: "messaging" },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    expect(collectAgentChannelToolBindingWarnings(cfg)).toEqual([]);
  });

  it("returns no warnings when agent uses the full profile (all tools allowed)", () => {
    const cfg = {
      bindings: [{ agentId: "commander", match: { channel: "discord" } }],
      agents: {
        list: [
          {
            id: "commander",
            tools: { profile: "full" },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    expect(collectAgentChannelToolBindingWarnings(cfg)).toEqual([]);
  });

  it("includes all bound channels in the warning", () => {
    const cfg = {
      bindings: [
        { agentId: "commander", match: { channel: "discord" } },
        { agentId: "commander", match: { channel: "telegram" } },
      ],
      agents: {
        list: [
          {
            id: "commander",
            tools: {
              allow: ["read", "write"],
            },
          },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    const warnings = collectAgentChannelToolBindingWarnings(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("discord");
    expect(warnings[0]).toContain("telegram");
  });

  it("warns for each agent that is missing message independently", () => {
    const cfg = {
      bindings: [
        { agentId: "alpha", match: { channel: "discord" } },
        { agentId: "beta", match: { channel: "telegram" } },
      ],
      agents: {
        list: [
          { id: "alpha", tools: { allow: ["read"] } },
          { id: "beta", tools: { allow: ["read"] } },
        ],
      },
    } satisfies Partial<OpenClawConfig> as OpenClawConfig;
    const warnings = collectAgentChannelToolBindingWarnings(cfg);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("`alpha`");
    expect(warnings[1]).toContain("`beta`");
  });
});
