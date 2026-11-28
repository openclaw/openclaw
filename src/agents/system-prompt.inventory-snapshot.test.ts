// Byte snapshots and budgets of the whole system prompt for the two measured install shapes.
import { describe, expect, it } from "vitest";
import { PROMPT_BUDGET_BYTES, SYSTEM_PROMPT_SECTIONS } from "./system-prompt-manifest.js";
import {
  buildAgentSystemPrompt,
  measureAgentSystemPromptSections,
  type AgentSystemPromptParams,
} from "./system-prompt.js";

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
  `Deferred tools: ${deferredTools.join(", ")}`,
  "Names are not directly callable: call dispatch_action with the name in id and all parameters in args, even when other guidance names the tool directly. tool_search gives input signatures and finds MCP/client tools; tool_describe gives full schemas.",
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

const freshParams: AgentSystemPromptParams = {
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
};

const configuredParams: AgentSystemPromptParams = {
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
};

describe("system prompt inventory snapshots", () => {
  it("renders the fresh-install prompt", async () => {
    await expect(buildAgentSystemPrompt(freshParams)).toMatchFileSnapshot(
      `${SNAPSHOT_DIR}/fresh.txt`,
    );
  });

  it("renders a configured channel agent's prompt", async () => {
    await expect(buildAgentSystemPrompt(configuredParams)).toMatchFileSnapshot(
      `${SNAPSHOT_DIR}/configured.txt`,
    );
  });

  it("keeps the fresh-install prompt and every section within budget", () => {
    expect(Buffer.byteLength(buildAgentSystemPrompt(freshParams), "utf8")).toBeLessThanOrEqual(
      PROMPT_BUDGET_BYTES.freshInstallSystemPrompt,
    );
    for (const params of [freshParams, configuredParams]) {
      const bytes = measureAgentSystemPromptSections(params);
      const over = SYSTEM_PROMPT_SECTIONS.filter(
        (section) => (bytes.get(section.id) ?? 0) > section.budgetBytes,
      ).map((section) => `${section.id}: ${bytes.get(section.id)} > ${section.budgetBytes}`);
      expect(over).toEqual([]);
    }
  });
});
