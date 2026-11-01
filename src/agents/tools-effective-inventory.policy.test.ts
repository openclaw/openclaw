import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolsConfig } from "../config/types.tools.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveConfiguredToolAccess } from "./tool-access-diagnostics.js";
import { attachToolAllowlistIntersection } from "./tool-policy-shared.js";
import { resolveEffectiveToolInventory } from "./tools-effective-inventory.js";

// mock-isolation: Policy fixtures use synthetic agents and mocked tools without auth database admission.
vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: async () => false,
}));

function messagingAgentConfig(tools: OpenClawConfig["tools"] = {}): OpenClawConfig {
  return {
    tools: { profile: "full", ...tools },
    agents: {
      defaults: { model: "openai/test-model" },
      entries: { assistant: { tools: { profile: "messaging" } } },
    },
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
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-visible-message-");
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each([
    { name: "configured empty", allow: [], exec: true, process: true },
    {
      name: "marked empty",
      allow: attachToolAllowlistIntersection([], [[]]),
      exec: false,
      process: false,
    },
    {
      name: "intersection",
      allow: attachToolAllowlistIntersection(["*"], [["ex*", "process"], ["*ec"]]),
      exec: true,
      process: false,
    },
  ])(
    "preserves $name sandbox policy through inventory preparation",
    async ({ allow, exec, process }) => {
      const result = await resolveEffectiveToolInventory({
        cfg: {},
        agentId: "main",
        workspaceDir: "/tmp/tool-access-workspace",
        agentDir: "/tmp/tool-access-agent",
        modelApi: null,
        sandboxToolPolicy: { allow },
      });
      const ids = new Set(result.groups.flatMap((group) => group.tools.map((tool) => tool.id)));
      expect([ids.has("exec"), ids.has("process")]).toEqual([exec, process]);
    },
  );

  it("explains local exclusion and repair for a normalized explicit agent key", () => {
    const agents: NonNullable<OpenClawConfig["agents"]> = {
      ownership: "explicit",
      entries: { other: {}, " Assistant ": { tools: { profile: "messaging" } } },
    };
    const toolsPath = 'agents.entries[" Assistant "].tools';
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

  it.each<{
    name: string;
    kind: "dashboard" | "subagent";
    createdVia?: SessionEntry["createdVia"];
    tools?: OpenClawConfig["tools"];
    inheritedToolDeny?: string[];
    available: boolean;
  }>([
    { name: "visible spawn", kind: "dashboard", createdVia: "spawn", available: true },
    { name: "hidden helper", kind: "subagent", createdVia: "spawn", available: false },
    { name: "unstamped dashboard child", kind: "dashboard", available: false },
    {
      name: "configured subagent deny",
      kind: "dashboard",
      createdVia: "spawn",
      tools: { subagents: { tools: { deny: ["message"] } } },
      available: false,
    },
    {
      name: "configured subagent allowlist",
      kind: "dashboard",
      createdVia: "spawn",
      tools: { subagents: { tools: { allow: ["read"] } } },
      available: false,
    },
    {
      name: "inherited deny",
      kind: "dashboard",
      createdVia: "spawn",
      inheritedToolDeny: ["message"],
      available: false,
    },
  ])("resolves message availability for $name", async (scenario) => {
    const dir = sessionDirs.make();
    const sessionKey = `agent:assistant:${scenario.kind}:child`;
    const storePath = path.join(dir, "agents/assistant/sessions/sessions.json");
    const cfg: OpenClawConfig = {
      ...messagingAgentConfig(scenario.tools),
      session: { store: storePath },
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "child",
        updatedAt: 1,
        createdVia: scenario.createdVia,
        spawnedBy: "agent:assistant:main",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: scenario.inheritedToolDeny,
      },
    );
    const result = await resolveEffectiveToolInventory({
      cfg,
      agentId: "assistant",
      sessionKey,
      workspaceDir: dir,
      agentDir: dir,
      modelApi: null,
    });
    const toolNames = result.groups.flatMap((group) => group.tools.map((tool) => tool.id));
    expect(toolNames.includes("message")).toBe(scenario.available);
    expect(result.toolAccess?.tools.find((tool) => tool.id === "message")?.status).toBe(
      scenario.available ? "available" : "excluded",
    );
    for (const tool of ["gateway", "session_status", "sessions_send", "conversations_send"]) {
      expect(toolNames).not.toContain(tool);
    }
  });
});
