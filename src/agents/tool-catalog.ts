import { CORE_TOOL_DEFINITIONS, type CoreToolId } from "./core-tool-facts.js";
/** Catalog presentation joins the canonical runtime-free tool facts. */
import {
  AGENTS_WAIT_TOOL_DISPLAY_SUMMARY,
  ASK_USER_TOOL_DISPLAY_SUMMARY,
  CRON_TOOL_DISPLAY_SUMMARY,
  EXEC_TOOL_DISPLAY_SUMMARY,
  PROCESS_TOOL_DISPLAY_SUMMARY,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
  SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
  SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
  SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY,
  SUGGEST_TASK_TOOL_DISPLAY_SUMMARY,
  DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
} from "./tool-description-presets.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

export {
  TOOL_CALL_RAW_TOOL_NAME,
  type ToolProfileId,
  type CoreToolFactoryFamily,
  resolveCoreToolFacts,
  type OpenClawCodingToolConstructionPlan,
  resolveCoreToolFactoryFamily,
  listCoreToolFactoryDescriptors,
  isCoreCodingSurfaceToolName,
  CORE_WORKER_LAUNCH_TOOL_NAMES,
  resolveCoreToolExecutionLocation,
  CORE_TOOL_GROUPS,
  PROFILE_OPTIONS,
  resolveCoreToolProfilePolicy,
  resolveCoreToolProfiles,
  isKnownCoreToolId,
} from "./core-tool-facts.js";

const CORE_TOOL_SECTION_ORDER: Array<{ id: string; label: string }> = [
  { id: "fs", label: "Files" },
  { id: "runtime", label: "Runtime" },
  { id: "web", label: "Web" },
  { id: "memory", label: "Memory" },
  { id: "sessions", label: "Sessions" },
  { id: "ui", label: "UI" },
  { id: "messaging", label: "Messaging" },
  { id: "automation", label: "Automation" },
  { id: "nodes", label: "Nodes" },
  { id: "agents", label: "Agents" },
  { id: "media", label: "Media" },
];

const CORE_TOOL_DESCRIPTIONS = {
  decision_evaluate: "Evaluate explicit evidence with the agent's decision model",
  ls: "List directory entries",
  read: "Read file contents",
  write: "Create or overwrite files",
  edit: "Make precise edits",
  apply_patch: "Patch files",
  exec: EXEC_TOOL_DISPLAY_SUMMARY,
  process: PROCESS_TOOL_DISPLAY_SUMMARY,
  code_execution: "Run sandboxed remote analysis",
  secrets: "Request and manage write-only credentials",
  web_search: "Search the web",
  web_fetch: "Fetch web content",
  x_search: "Search X posts",
  memory_search: "Semantic search",
  memory_get: "Read memory files",
  personal_instructions: "Edit the requesting user’s personal instructions",
  presence: "Online people, connected devices, recent activity, and connection location",
  sessions: "Session settings: label, pin, archive, groups",
  sessions_create: "Create an independent session, optionally starting work",
  sessions_list: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
  sessions_history: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
  sessions_search: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
  conversations_list: "List exact external conversation addresses",
  conversations_send: "Send to an exact external conversation",
  conversations_turn: "Send and wait for a correlated external reply",
  sessions_send: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
  sessions_spawn: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
  github_identity_status: "Inspect the effective GitHub identity and credential health",
  github_publish: "Publish the reconciled session worktree as a draft GitHub pull request",
  agents_wait: AGENTS_WAIT_TOOL_DISPLAY_SUMMARY,
  sessions_yield: "End turn to receive sub-agent results",
  subagents: "Background work: subagents, media gen, automation runs. list/cancel.",
  session_status: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
  suggest_task: SUGGEST_TASK_TOOL_DISPLAY_SUMMARY,
  dismiss_task: DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
  browser: "Control web browser",
  screen: "Drive operator web UI",
  theme: "List, select, and create appearance themes",
  dashboard: "Read and arrange the session dashboard",
  terminal: "Use shared operator terminals with policy-governed input",
  portal: "Expose local web apps through the gateway",
  canvas: "Control node Canvas surfaces when the Canvas plugin is enabled",
  show_widget: "Show an interactive widget on chat or an auto-fitting dashboard",
  message: "Send messages",
  [AUTOMATIONS_TOOL_NAME]: CRON_TOOL_DISPLAY_SUMMARY,
  gateway: "Update OpenClaw; read Gateway config/schema when permitted",
  plugins: "Manage and reload plugins",
  openclaw: "Delegate OpenClaw setup and repair",
  nodes: "Nodes + devices",
  computer: "Control the Gateway desktop or a paired computer",
  mobile_ui: "Observe and control a paired Android app",
  agents_list: "List agents",
  get_goal: "Get current thread goal",
  create_goal: "Create a thread goal",
  update_goal: "Complete or block a thread goal",
  progress_card: "Maintain the session progress card",
  ask_user: ASK_USER_TOOL_DISPLAY_SUMMARY,
  skill_workshop: SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY,
  skills_search: "Search installed eligible skills",
  skills_read: "Read complete installed skill instructions",
  view_image: "Image understanding",
  image_generate: "Image generation",
  music_generate: "Music generation",
  video_generate: "Video generation",
  transcripts: "Inspect and manage meeting transcript captures",
  tts: "Text-to-speech conversion",
  pdf: "PDF reading and extraction",
} satisfies Record<CoreToolId, string>;

// Section membership is static; capability filtering and response objects stay per request.
const CORE_TOOL_SECTIONS = CORE_TOOL_SECTION_ORDER.map(({ id, label }) => ({
  id,
  label,
  tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === id),
}));

/** Lists configurable core tools; per-run authorization belongs to runtime assembly. */
export function listCoreToolSections(params?: {
  swarmEnabled?: boolean;
  personalInstructionsEnabled?: boolean;
}): Array<{
  id: string;
  label: string;
  tools: Array<{
    id: string;
    label: string;
    description: string;
  }>;
}> {
  // Callers resolve the swarm gate and pass the fact in; resolving config here
  // would couple this ui-shared module to the server graph.
  const swarmEnabled = params?.swarmEnabled === true;
  return CORE_TOOL_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    tools: section.tools
      .filter(
        (tool) =>
          (tool.id !== "agents_wait" || swarmEnabled) &&
          (tool.id !== "personal_instructions" || params?.personalInstructionsEnabled === true),
      )
      .map((tool) => ({
        id: tool.id,
        label: tool.id,
        description: CORE_TOOL_DESCRIPTIONS[tool.id],
      })),
  })).filter((section) => section.tools.length > 0);
}
