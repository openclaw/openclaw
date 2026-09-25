import { beforeEach, describe, expect, it } from "vitest";
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

function messagingAgentConfig(tools: OpenClawConfig["tools"] = {}): OpenClawConfig {
  return {
    tools: { profile: "full", ...tools },
    agents: { entries: { assistant: { tools: { profile: "messaging" } } } },
  };
}

describe("tool access diagnostics", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("explains a local profile override without claiming live tool availability", () => {
    const result = resolveConfiguredToolAccess({
      config: messagingAgentConfig(),
      agentId: "assistant",
      toolNames: ["exec", "process", "session_status"],
    });

    expect(result).toEqual({
      checked: "local-config",
      profiles: [
        { profile: "full", source: "tools.profile", active: false },
        { profile: "messaging", source: "agents.entries.assistant.tools.profile", active: true },
      ],
      tools: [
        ...["exec", "process"].map((id) => ({
          id,
          status: "excluded",
          reasons: [
            {
              kind: "profile",
              label: "messaging profile",
              source: "agents.entries.assistant.tools.profile",
              profile: "messaging",
            },
          ],
          alsoAllowPath: "agents.entries.assistant.tools.alsoAllow",
        })),
        { id: "session_status", status: "allowed", reasons: [] },
      ],
    });
  });

  it.each<{ agents: NonNullable<OpenClawConfig["agents"]>; toolsPath: string }>([
    {
      agents: {
        list: [{ id: "other" }, { id: " Assistant ", tools: { profile: "messaging" } }],
      },
      toolsPath: "agents.list[1].tools",
    },
    {
      agents: { entries: { " Assistant ": { tools: { profile: "messaging" } } } },
      toolsPath: 'agents.entries[" Assistant "].tools',
    },
  ])(
    "preserves the authored $toolsPath location in profile repair guidance",
    ({ agents, toolsPath }) => {
      const result = resolveConfiguredToolAccess({
        config: { tools: { profile: "full" }, agents },
        agentId: "assistant",
        toolNames: ["exec"],
      });

      expect(result.profiles).toContainEqual({
        profile: "messaging",
        source: `${toolsPath}.profile`,
        active: true,
      });
      expect(result.tools[0]).toMatchObject({
        status: "excluded",
        reasons: [{ source: `${toolsPath}.profile` }],
        alsoAllowPath: `${toolsPath}.alsoAllow`,
      });
    },
  );

  it.each<{ tools: ToolsConfig; source: string; kind: "deny" | "allowlist" | "profile" }>([
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
  ])(
    "reports a later $source blocker and omits an ineffective profile repair",
    ({ tools, source, kind }) => {
      const result = resolveConfiguredToolAccess({
        config: messagingAgentConfig(tools),
        agentId: "assistant",
        modelProvider: "openai",
        modelId: "test-model",
      });
      const exec = result.tools.find((tool) => tool.id === "exec");

      expect(exec?.status).toBe("excluded");
      expect(exec?.reasons).toHaveLength(2);
      expect(exec?.reasons[1]).toMatchObject({ kind, source });
      expect(exec).not.toHaveProperty("alsoAllowPath");
    },
  );

  it("does not suggest replacing inherited alsoAllow grants with an agent list", () => {
    const result = resolveConfiguredToolAccess({
      config: messagingAgentConfig({ alsoAllow: ["browser"] }),
      agentId: "assistant",
    });

    expect(result.tools.find((tool) => tool.id === "exec")).toMatchObject({ status: "excluded" });
    expect(result.tools.find((tool) => tool.id === "exec")).not.toHaveProperty("alsoAllowPath");
  });

  it("observes actual inventory filtering and explicit profile repair", () => {
    const inventory = (cfg: OpenClawConfig) =>
      resolveEffectiveToolInventory({
        cfg,
        agentId: "assistant",
        sessionKey: "agent:assistant:main",
        workspaceDir: "/tmp/tool-access-workspace",
        agentDir: "/tmp/tool-access-agent",
        modelApi: null,
      });

    const before = inventory(messagingAgentConfig());
    expect(before.groups.flatMap((group) => group.tools.map((tool) => tool.id))).not.toContain(
      "exec",
    );
    expect(before.toolAccess?.checked).toBe("live-session");
    expect(before.toolAccess?.profiles).toContainEqual({
      profile: "full",
      source: "tools.profile",
      active: false,
    });
    expect(before.toolAccess?.tools.find((tool) => tool.id === "exec")).toEqual({
      id: "exec",
      status: "excluded",
      reasons: [
        {
          kind: "profile",
          label: "messaging profile",
          source: "agents.entries.assistant.tools.profile",
          profile: "messaging",
        },
      ],
      alsoAllowPath: "agents.entries.assistant.tools.alsoAllow",
    });

    const after = inventory({
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

  it("preserves the prepared session ceiling when explaining a profile exclusion", () => {
    const cfg = messagingAgentConfig();
    const sessionKey = "agent:assistant:subagent:diagnostics";
    const conversationCapabilityProfile = resolveConversationCapabilityProfile({
      config: cfg,
      agentId: "assistant",
      sessionKey,
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
    });
    const result = resolveEffectiveToolInventory({
      cfg,
      agentId: "assistant",
      sessionKey,
      workspaceDir: "/tmp/tool-access-workspace",
      agentDir: "/tmp/tool-access-agent",
      modelApi: null,
      conversationCapabilityProfile,
    });
    const exec = result.toolAccess?.tools.find((tool) => tool.id === "exec");

    expect(exec?.reasons.map((reason) => reason.kind)).toEqual(["profile", "session"]);
    expect(exec).not.toHaveProperty("alsoAllowPath");
    expect(result.groups.flatMap((group) => group.tools.map((tool) => tool.id))).not.toContain(
      "exec",
    );
  });
});
