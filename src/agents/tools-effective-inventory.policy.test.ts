import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolsConfig } from "../config/types.tools.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveConfiguredToolAccess } from "./tool-access-diagnostics.js";
import { resolveEffectiveToolInventory } from "./tools-effective-inventory.js";

// mock-isolation: Policy fixtures use synthetic agents and mocked tools without auth database admission.
vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: async () => false,
}));

function messagingAgentConfig(tools: OpenClawConfig["tools"] = {}): OpenClawConfig {
  return {
    tools: { profile: "full", ...tools },
    agents: { entries: { assistant: { tools: { profile: "messaging" } } } },
  };
}

function excludedByMessagingProfile(id: string, toolsPath = "agents.entries.assistant.tools") {
  return {
    id,
    status: "excluded",
    reasons: [
      {
        kind: "profile",
        label: "messaging profile",
        source: `${toolsPath}.profile`,
        profile: "messaging",
      },
    ],
    alsoAllowPath: `${toolsPath}.alsoAllow`,
  };
}

describe("tool access diagnostics", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each<{ agents: NonNullable<OpenClawConfig["agents"]>; toolsPath: string }>([
    {
      agents: { entries: { assistant: { tools: { profile: "messaging" } } } },
      toolsPath: "agents.entries.assistant.tools",
    },
    {
      agents: {
        ownership: "explicit",
        entries: { other: {}, " Assistant ": { tools: { profile: "messaging" } } },
      },
      toolsPath: 'agents.entries[" Assistant "].tools',
    },
    {
      agents: { entries: { " Assistant ": { tools: { profile: "messaging" } } } },
      toolsPath: 'agents.entries[" Assistant "].tools',
    },
  ])("explains local exclusion and repair at $toolsPath", ({ agents, toolsPath }) => {
    const result = resolveConfiguredToolAccess({
      config: { tools: { profile: "full" }, agents },
      agentId: "assistant",
      toolNames: ["exec", "process", "session_status"],
    });
    expect(result).toEqual({
      checked: "local-config",
      profiles: [
        { profile: "full", source: "tools.profile", active: false },
        { profile: "messaging", source: `${toolsPath}.profile`, active: true },
      ],
      tools: [
        ...["exec", "process"].map((id) => excludedByMessagingProfile(id, toolsPath)),
        { id: "session_status", status: "allowed", reasons: [] },
      ],
    });
  });

  it.each<{ tools: ToolsConfig; source: string; kind: "deny" | "allowlist" | "profile" }>([
    {
      tools: { alsoAllow: ["browser"] },
      source: "agents.entries.assistant.tools.profile",
      kind: "profile",
    },
    { tools: { deny: ["ex*"] }, source: "tools.deny", kind: "deny" },
    { tools: { allow: ["process"] }, source: "tools.allow", kind: "allowlist" },
    {
      tools: { byProvider: { "openai/test-model": { deny: ["exec"] } } },
      source: 'tools.byProvider["openai/test-model"].deny',
      kind: "deny",
    },
    {
      tools: { byProvider: { openai: { profile: "minimal" } } },
      source: 'tools.byProvider["openai"].profile',
      kind: "profile",
    },
  ])("omits ineffective or destructive profile repair for $source", ({ tools, source, kind }) => {
    const result = resolveConfiguredToolAccess({
      config: messagingAgentConfig(tools),
      agentId: "assistant",
      modelProvider: "openai",
      modelId: "test-model",
    });
    const exec = result.tools.find((tool) => tool.id === "exec");

    expect(exec?.status).toBe("excluded");
    expect(exec?.reasons).toHaveLength(tools.alsoAllow ? 1 : 2);
    expect(exec?.reasons.at(-1)).toMatchObject({ kind, source });
    expect(exec).not.toHaveProperty("alsoAllowPath");
  });

  it("observes actual inventory filtering and explicit profile repair", async () => {
    const inventory = (cfg: OpenClawConfig) =>
      resolveEffectiveToolInventory({
        cfg,
        agentId: "assistant",
        sessionKey: "agent:assistant:main",
        workspaceDir: "/tmp/tool-access-workspace",
        agentDir: "/tmp/tool-access-agent",
        modelApi: null,
      });

    const before = await inventory(messagingAgentConfig());
    expect(before.groups.flatMap((group) => group.tools.map((tool) => tool.id))).not.toContain(
      "exec",
    );
    expect(before.toolAccess?.checked).toBe("live-session");
    expect(before.toolAccess?.profiles).toContainEqual({
      profile: "full",
      source: "tools.profile",
      active: false,
    });
    expect(before.toolAccess?.tools.find((tool) => tool.id === "exec")).toEqual(
      excludedByMessagingProfile("exec"),
    );

    const after = await inventory({
      tools: { profile: "full" },
      agents: {
        entries: {
          assistant: { tools: { profile: "messaging", alsoAllow: ["exec", "process"] } },
        },
      },
    });
    expect(after.groups.flatMap((group) => group.tools.map((tool) => tool.id))).toEqual(
      expect.arrayContaining(["exec", "process"]),
    );
    expect(after.toolAccess?.tools.find((tool) => tool.id === "exec")).toEqual({
      id: "exec",
      status: "available",
      reasons: [],
    });
  });

  it.each([false, true])(
    "uses prepared inventory policy and session ceiling=%s",
    async (ceiling) => {
      const cfg = messagingAgentConfig();
      const sessionKey = ceiling ? "agent:assistant:subagent:diagnostics" : "agent:assistant:main";
      const conversationCapabilityProfile = resolveConversationCapabilityProfile({
        config: cfg,
        agentId: "assistant",
        sessionKey,
        ...(ceiling
          ? {
              workspaceDir: "/tmp/tool-access-workspace",
              preparedSessionEntry: {
                sessionKey,
                entry: {
                  sessionId: "diagnostics-session",
                  spawnedBy: "agent:assistant:main",
                  spawnDepth: 1,
                  inheritedToolPolicyVersion: 1,
                  inheritedToolDeny: ["exec"],
                },
              },
            }
          : {}),
      });
      const result = await resolveEffectiveToolInventory({
        cfg: ceiling ? cfg : { tools: { profile: "full" } },
        agentId: "assistant",
        sessionKey,
        workspaceDir: "/tmp/tool-access-workspace",
        agentDir: "/tmp/tool-access-agent",
        modelApi: null,
        conversationCapabilityProfile,
      });
      expect(result.profile).toBe("messaging");
      expect(result.groups.flatMap((group) => group.tools.map((tool) => tool.id))).not.toContain(
        "exec",
      );
      if (ceiling) {
        const exec = result.toolAccess?.tools.find((tool) => tool.id === "exec");
        expect(exec?.reasons.map((reason) => reason.kind)).toEqual(["profile", "session"]);
        expect(exec).not.toHaveProperty("alsoAllowPath");
      }
    },
  );
});
