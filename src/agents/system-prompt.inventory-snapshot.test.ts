// Byte snapshots of the whole system prompt for the two measured install shapes.
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const SNAPSHOT_DIR = "../../test/fixtures/agents/prompt-snapshots/system-prompt";

const visibleTools = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "ls",
  "exec",
  "process",
  "message",
  "openclaw",
  "sessions_yield",
  "dispatch_action",
  "progress_card",
  "session_project",
  "tool_describe",
  "tool_search",
];
const deferredTools = [
  "agents_list",
  "agents_wait",
  "ask_user",
  "automations",
  "browser",
  "dashboard",
  "gateway",
  "memory_get",
  "memory_search",
  "nodes",
  "plugins",
  "portal",
  "screen",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
  "show_widget",
  "skills_read",
  "skills_search",
  "subagents",
  "tts",
  "web_fetch",
];
const directory = [
  "Available deferred-schema tools:",
  ...deferredTools.map((name) => `- ${name} (core): Deferred ${name} tool.`),
  "",
  "Policy-approved MCP and client tools may also be discoverable through search.",
  "Use tool_search for a compact input signature or tool_describe for a full schema.",
].join("\n");
const skillsPrompt = [
  "<available_skills>",
  ...["github", "healthcheck", "team-release"].map(
    (name) =>
      `  <skill>\n    <name>${name}</name>\n    <description>Run the ${name} workflow.</description>\n    <location>/repo/skills/${name}/SKILL.md</location>\n  </skill>`,
  ),
  "</available_skills>",
].join("\n");
const runtimeInfo = {
  agentId: "main",
  sessionKey: "agent:main:explicit:inventory",
  host: "inventory-host",
  os: "Darwin 27.0.0",
  arch: "arm64",
  node: "v24.0.0",
  model: "fake/fake-model",
  defaultModel: "fake/fake-model",
  shell: "zsh",
};

describe("system prompt inventory snapshots", () => {
  it("renders the fresh-install prompt", async () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      toolNames: visibleTools,
      capabilityToolNames: deferredTools,
      toolSchemaDirectoryPrompt: directory,
      skillsPrompt,
      webSearchUnconfigured: true,
      contextFiles: [
        { path: "/workspace/AGENTS.md", content: "[MISSING] Expected at: /workspace/AGENTS.md" },
      ],
      runtimeInfo,
      reasoningCommandsEnabled: true,
      acpEnabled: true,
      docsPath: "/repo/docs",
      sourcePath: "/repo",
    });
    await expect(prompt).toMatchFileSnapshot(`${SNAPSHOT_DIR}/fresh.txt`);
  });

  it("renders a configured channel agent's prompt", async () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/workspace",
      runtimeCwd: "/workspace/project",
      toolNames: visibleTools,
      capabilityToolNames: deferredTools,
      toolSchemaDirectoryPrompt: directory,
      skillsPrompt,
      contextFiles: [
        { path: "/workspace/AGENTS.md", content: "# AGENTS.md\n\nRead SOUL.md first." },
        { path: "/workspace/SOUL.md", content: "# SOUL.md\n\nYou are Pip." },
        { path: "/workspace/USER.md", content: "# USER.md\n\nName: Sam." },
        { path: "/workspace/MEMORY.md", content: "# MEMORY.md\n\n- Sam ships on Fridays." },
      ],
      extraSystemPrompt: "Group chat: #ops. Keep replies short.",
      ownerNumbers: ["10001"],
      modelAliasLines: ["- fast: fake/fake-small"],
      reactionGuidance: { level: "minimal", channel: "Telegram" },
      ttsHint: "Voice replies use the configured voice.",
      sourceReplyDeliveryMode: "automatic",
      runtimeInfo: {
        ...runtimeInfo,
        sessionKey: "agent:main:telegram:direct:10001",
        channel: "telegram",
        chatType: "direct",
        capabilities: ["inlineButtons", "markdownDetails"],
      },
      reasoningCommandsEnabled: true,
      acpEnabled: true,
      docsPath: "/repo/docs",
      sourcePath: "/repo",
      sandboxInfo: {
        enabled: true,
        containerWorkspaceDir: "/sandbox/workspace",
        workspaceDir: "/workspace",
        workspaceAccess: "rw",
        elevated: { allowed: true, defaultLevel: "ask", fullAccessAvailable: true },
      },
    });
    await expect(prompt).toMatchFileSnapshot(`${SNAPSHOT_DIR}/configured.txt`);
  });
});
