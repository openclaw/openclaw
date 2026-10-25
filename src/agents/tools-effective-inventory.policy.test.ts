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
type InventoryOptions = Parameters<typeof resolveEffectiveToolInventory>[0];
const workspaceDir = "/tmp/tool-access-workspace";
function inventory(cfg: OpenClawConfig, options: Partial<InventoryOptions> = {}) {
  return resolveEffectiveToolInventory({
    cfg,
    agentId: "assistant",
    sessionKey: "agent:assistant:main",
    workspaceDir,
    agentDir: "/tmp/tool-access-agent",
    modelApi: null,
    ...options,
  });
}
const names = (result: Awaited<ReturnType<typeof inventory>>) =>
  result.groups.flatMap((group) => group.tools.map((tool) => tool.id));

describe("tool access diagnostics", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-visible-message-");
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

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

  it.each<[ToolsConfig, string, "deny" | "allowlist" | "profile"]>([
    [{ alsoAllow: ["browser"] }, "agents.entries.assistant.tools.profile", "profile"],
    [{ deny: ["ex*"] }, "tools.deny", "deny"],
    [{ allow: ["process"] }, "tools.allow", "allowlist"],
    [
      { byProvider: { "openai/test-model": { deny: ["exec"] } } },
      'tools.byProvider["openai/test-model"].deny',
      "deny",
    ],
    [
      { byProvider: { openai: { profile: "minimal" } } },
      'tools.byProvider["openai"].profile',
      "profile",
    ],
  ])("omits ineffective or destructive profile repair for %j (%s)", (tools, source, kind) => {
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
    const before = await inventory(messagingAgentConfig());
    expect(names(before)).not.toContain("exec");
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
    expect(names(after)).toEqual(expect.arrayContaining(["exec", "process"]));
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
              workspaceDir,
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
      const result = await inventory(ceiling ? cfg : { tools: { profile: "full" } }, {
        sessionKey,
        conversationCapabilityProfile,
      });
      expect(result.profile).toBe("messaging");
      expect(names(result)).not.toContain("exec");
      if (ceiling) {
        const exec = result.toolAccess?.tools.find((tool) => tool.id === "exec");
        expect(exec?.reasons.map((reason) => reason.kind)).toEqual(["profile", "session"]);
        expect(exec).not.toHaveProperty("alsoAllowPath");
      }
    },
  );

  it.each<
    [
      string,
      "dashboard" | "subagent",
      SessionEntry["createdVia"],
      boolean,
      OpenClawConfig["tools"]?,
      string[]?,
    ]
  >([
    ["visible spawn", "dashboard", "spawn", true],
    ["hidden helper", "subagent", "spawn", false],
    ["unstamped dashboard child", "dashboard", undefined, false],
    [
      "configured subagent deny",
      "dashboard",
      "spawn",
      false,
      { subagents: { tools: { deny: ["message"] } } },
    ],
    [
      "configured subagent allowlist",
      "dashboard",
      "spawn",
      false,
      { subagents: { tools: { allow: ["read"] } } },
    ],
    ["inherited deny", "dashboard", "spawn", false, undefined, ["message"]],
  ])(
    "resolves message availability for %s",
    async (_name, kind, createdVia, available, tools, inheritedToolDeny) => {
      const dir = sessionDirs.make();
      const sessionKey = `agent:assistant:${kind}:child`;
      const storePath = path.join(dir, "agents/assistant/sessions/sessions.json");
      const cfg: OpenClawConfig = {
        ...messagingAgentConfig(tools),
        session: { store: storePath },
      };
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "child",
          updatedAt: 1,
          createdVia,
          spawnedBy: "agent:assistant:main",
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolDeny,
        },
      );
      const result = await inventory(cfg, {
        sessionKey,
        workspaceDir: dir,
        agentDir: dir,
      });
      const toolNames = names(result);
      expect(toolNames.includes("message")).toBe(available);
      expect(result.toolAccess?.tools.find((tool) => tool.id === "message")?.status).toBe(
        available ? "available" : "excluded",
      );
      for (const tool of ["gateway", "session_status", "sessions_send", "conversations_send"]) {
        expect(toolNames).not.toContain(tool);
      }
    },
  );
});
