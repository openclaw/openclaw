import type { AgentPromptSurfaceKind } from "../plugins/types.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

type SystemPromptToolListParams = {
  visibleTools: ReadonlyMap<string, string>;
  availableTools: ReadonlySet<string>;
  codeModeActive?: boolean;
  promptSurface: AgentPromptSurfaceKind;
  acpSpawnRuntimeEnabled: boolean;
};

/** Render the visible tool list with stable core ordering and caller-provided names. */
export function buildSystemPromptToolLines(params: SystemPromptToolListParams): string[] {
  const { visibleTools, availableTools, promptSurface, acpSpawnRuntimeEnabled } = params;
  const coreToolSummaries: Record<string, string> = {
    read: "Read files",
    write: "Write files",
    edit: "Exact file edits",
    apply_patch: "Patch files",
    grep: "Search file contents",
    find: "Find files by glob",
    ls: "List directories",
    exec: params.codeModeActive
      ? "Run JavaScript/TypeScript Code Mode; call exact catalog tools from code, never shell/Python/imports"
      : promptSurface === "cli_backend"
        ? "Run shell on connected node; sync; host=node"
        : "Run shell; pty for TTY CLIs",
    wait: "Resume a suspended Code Mode exec",
    process: "Control background exec",
    web_search: "Web search",
    web_fetch: "Fetch/extract URL",
    // Channel docking: add login tools here when a channel needs interactive linking.
    browser: "Control browser",
    screen: "Drive operator web UI",
    theme: "List, select, and create appearance themes",
    terminal:
      "List/read/resize/close operator-opened session terminals; input follows exec policy and may require exact-input approval; never open shells",
    canvas: "Present/eval/snapshot Canvas",
    nodes: "Paired node status/control/media",
    [AUTOMATIONS_TOOL_NAME]:
      "Schedule/wake. Reminder text must read as reminder when fired; mention reminder for delayed gaps; include useful recent context. This feature is called automations; never call it cron.",
    message: "Message/channel actions",
    conversations_list: "List exact external conversation addresses",
    conversations_send: "Send directly to an external conversation",
    conversations_turn: "Send and wait for one correlated external reply",
    openclaw: "Gateway restart/system setup/config",
    gateway:
      "Read this Gateway's config/schema; owner-only self-update on explicit request; automatic restart and completion notice",
    agents_list: acpSpawnRuntimeEnabled
      ? "List allowed OpenClaw subagent ids; not ACP ids"
      : "List allowed subagent ids",
    sessions_list: "List visible sessions; filters/last",
    sessions_history: "Read visible session/subagent history",
    sessions_search: availableTools.has("sessions_history")
      ? "Search past sessions; use sessionKey with sessions_history"
      : "Search past sessions",
    sessions_send: "Message other session/subagent",
    sessions_spawn: acpSpawnRuntimeEnabled
      ? `Spawn subagent/ACP. Native clean context: context="isolated"; transcript: context="fork". ACP needs agentId unless default; ids from acp.allowedAgents${availableTools.has("agents_list") ? ", not agents_list" : ""}.`
      : 'Spawn subagent; clean context: context="isolated"; transcript: context="fork"',
    sessions_yield: "End turn; await subagent events",
    subagents: "Subagent status; never wait-loop",
    session_status: "Session/model/usage/time/status; model override",
    skill_workshop: "Author reusable skills",
    image: "Analyze images",
    image_generate: "Generate/edit images",
  };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "grep",
    "find",
    "ls",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "browser",
    "screen",
    "theme",
    "terminal",
    "canvas",
    "nodes",
    AUTOMATIONS_TOOL_NAME,
    "message",
    "conversations_list",
    "conversations_send",
    "conversations_turn",
    "openclaw",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_search",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "subagents",
    "session_status",
    "skill_workshop",
    "view_image",
    "image_generate",
  ];

  const resolveToolName = (normalized: string) => visibleTools.get(normalized) ?? normalized;
  const extraTools = [...visibleTools.keys()].filter((tool) => !toolOrder.includes(tool));
  const enabledTools = toolOrder.filter((tool) => visibleTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = coreToolSummaries[tool];
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  for (const tool of extraTools.toSorted()) {
    const summary = coreToolSummaries[tool];
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }
  return toolLines;
}
