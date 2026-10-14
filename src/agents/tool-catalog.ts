/**
 * Core tool catalog and profile defaults.
 * Drives built-in profile allowlists, group expansion, and UI section metadata
 * for OpenClaw-owned tools.
 *
 * This module is bundled into the Control UI via tool-policy-shared. Keep it
 * pure data + tiny pure functions: a value import of server config/runtime
 * modules here drags the whole gateway graph into the ui build and breaks it.
 */
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

/** Built-in tool profile ids exposed in config and UI. */
export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

/** Allow/deny policy generated from a built-in tool profile. */
type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

type CoreToolSection = {
  id: string;
  label: string;
  tools: Array<{
    id: string;
    label: string;
    description: string;
  }>;
};

type CoreToolDefinition = {
  id: string;
  description: string;
  sectionId: string;
  profiles: ToolProfileId[];
  executionLocation?: "placement" | "gateway";
  includeInSectionGroup?: boolean;
  includeInOpenClawGroup?: boolean;
};

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

type CoreToolOptions = Omit<CoreToolDefinition, "id" | "description" | "sectionId">;

function coreTools(
  sectionId: string,
  defaults: CoreToolOptions,
  tools: Array<[id: string, description: string, options?: Partial<CoreToolOptions>]>,
): CoreToolDefinition[] {
  return tools.map(([id, description, options]) => ({
    id,
    description,
    sectionId,
    ...defaults,
    ...options,
  }));
}

const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  ...coreTools("agents", { profiles: ["coding", "messaging"], includeInOpenClawGroup: true }, [
    ["decision_evaluate", "Evaluate explicit evidence with the agent's decision model"],
  ]),
  ...coreTools("fs", { profiles: ["coding"], executionLocation: "placement" }, [
    ["ls", "List directory entries"],
    ["read", "Read file contents"],
    ["write", "Create or overwrite files"],
    ["edit", "Make precise edits"],
    ["apply_patch", "Patch files"],
  ]),
  ...coreTools("runtime", { profiles: ["coding"] }, [
    ["exec", EXEC_TOOL_DISPLAY_SUMMARY, { executionLocation: "placement" }],
    ["process", PROCESS_TOOL_DISPLAY_SUMMARY, { executionLocation: "placement" }],
    ["code_execution", "Run sandboxed remote analysis", { includeInOpenClawGroup: true }],
    [
      "secrets",
      "Request and manage write-only credentials",
      {
        profiles: ["coding", "messaging"],
        includeInOpenClawGroup: true,
      },
    ],
  ]),
  ...coreTools("web", { profiles: ["coding"], includeInOpenClawGroup: true }, [
    ["web_search", "Search the web"],
    ["web_fetch", "Fetch web content"],
    ["x_search", "Search X posts"],
  ]),
  ...coreTools("memory", { profiles: ["coding"], includeInOpenClawGroup: true }, [
    ["memory_search", "Semantic search"],
    ["memory_get", "Read memory files"],
    [
      "personal_instructions",
      "Edit the requesting user’s personal instructions",
      { profiles: ["coding", "messaging"] },
    ],
  ]),
  ...coreTools("sessions", { profiles: ["coding", "messaging"], includeInOpenClawGroup: true }, [
    [
      "presence",
      "Online people, connected devices, recent activity, and connection location",
      { executionLocation: "gateway", profiles: ["minimal", "coding", "messaging"] },
    ],
    ["sessions", "Session settings: label, pin, archive, groups"],
    ["sessions_list", SESSIONS_LIST_TOOL_DISPLAY_SUMMARY],
    ["sessions_history", SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY],
    ["sessions_search", SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY],
    ["conversations_list", "List exact external conversation addresses"],
    ["conversations_send", "Send to an exact external conversation"],
    ["conversations_turn", "Send and wait for a correlated external reply"],
    ["sessions_send", SESSIONS_SEND_TOOL_DISPLAY_SUMMARY, { executionLocation: "gateway" }],
    ["sessions_spawn", SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY, { executionLocation: "gateway" }],
    [
      "github_identity_status",
      "Inspect the effective GitHub identity and credential health",
      { profiles: ["coding"] },
    ],
    [
      "github_publish",
      "Publish the reconciled session worktree as a draft GitHub pull request",
      { profiles: ["coding"] },
    ],
    ["agents_wait", AGENTS_WAIT_TOOL_DISPLAY_SUMMARY, { profiles: ["coding"] }],
    ["sessions_yield", "End turn to receive sub-agent results"],
    ["subagents", "Background work: subagents, media gen, automation runs. list/cancel."],
    [
      "session_status",
      SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
      { profiles: ["minimal", "coding", "messaging"] },
    ],
    ["suggest_task", SUGGEST_TASK_TOOL_DISPLAY_SUMMARY, { profiles: ["coding"] }],
    ["dismiss_task", DISMISS_TASK_TOOL_DISPLAY_SUMMARY, { profiles: ["coding"] }],
  ]),
  ...coreTools("ui", { profiles: ["coding"], includeInOpenClawGroup: true }, [
    ["browser", "Control web browser", { executionLocation: "placement", profiles: [] }],
    ["screen", "Drive operator web UI"],
    ["theme", "List, select, and create appearance themes", { profiles: ["coding", "messaging"] }],
    ["dashboard", "Read and arrange the session dashboard"],
    ["terminal", "Use shared operator terminals with policy-governed input"],
    ["portal", "Expose local web apps through the gateway", { executionLocation: "gateway" }],
    [
      "canvas",
      "Control node Canvas surfaces when the Canvas plugin is enabled",
      { profiles: [], includeInOpenClawGroup: false },
    ],
    [
      "show_widget",
      "Show an interactive widget on chat or an auto-fitting dashboard",
      { profiles: [] },
    ],
  ]),
  ...coreTools("messaging", { profiles: ["messaging"], includeInOpenClawGroup: true }, [
    ["message", "Send messages"],
  ]),
  ...coreTools("automation", { profiles: [], includeInOpenClawGroup: true }, [
    ["heartbeat_respond", "Accept heartbeat outcomes for post-turn handling"],
    [AUTOMATIONS_TOOL_NAME, CRON_TOOL_DISPLAY_SUMMARY, { profiles: ["coding"] }],
    [
      "gateway",
      "Update OpenClaw; read Gateway config/schema when permitted",
      { profiles: ["minimal", "coding", "messaging"] },
    ],
    ["plugins", "Manage and reload plugins", { profiles: ["coding"] }],
    ["openclaw", "Delegate OpenClaw setup and repair"],
  ]),
  ...coreTools("nodes", { profiles: [], includeInOpenClawGroup: true }, [
    ["nodes", "Nodes + devices"],
    [
      "computer",
      "Control the Gateway desktop or a paired computer",
      { executionLocation: "placement" },
    ],
    ["mobile_ui", "Observe and control a paired Android app"],
  ]),
  ...coreTools("agents", { profiles: ["coding"], includeInOpenClawGroup: true }, [
    ["agents_list", "List agents", { profiles: [] }],
    ["get_goal", "Get current thread goal"],
    ["create_goal", "Create a thread goal"],
    ["update_goal", "Complete or block a thread goal"],
    ["progress_card", "Maintain the session progress card"],
    ["ask_user", ASK_USER_TOOL_DISPLAY_SUMMARY, { profiles: ["coding", "messaging"] }],
    ["skill_workshop", SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY, { executionLocation: "gateway" }],
    ["skills_search", "Search installed eligible skills"],
    ["skills_read", "Read complete installed skill instructions"],
  ]),
  ...coreTools("media", { profiles: ["coding"], includeInOpenClawGroup: true }, [
    ["view_image", "Image understanding"],
    ["image_generate", "Image generation"],
    ["music_generate", "Music generation"],
    ["video_generate", "Video generation"],
    // Catalog visibility must not change existing media group policies.
    [
      "transcripts",
      "Inspect and manage meeting transcript captures",
      { profiles: [], includeInSectionGroup: false, includeInOpenClawGroup: false },
    ],
    ["tts", "Text-to-speech conversion", { profiles: [] }],
    ["pdf", "PDF reading and extraction", { profiles: [] }],
  ]),
];

const CORE_TOOL_BY_ID = new Map<string, CoreToolDefinition>(
  CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

// Keep Gateway declarations for 2026.9.8 until the next supervisor dialect.
export const CORE_WORKER_LAUNCH_TOOL_NAMES = Object.freeze(
  CORE_TOOL_DEFINITIONS.filter((tool) => tool.executionLocation).map((tool) => tool.id),
);

export function resolveCoreToolExecutionLocation(toolId: string): "placement" | "gateway" {
  return CORE_TOOL_BY_ID.get(toolId)?.executionLocation ?? "gateway";
}

// Section membership is static; capability filtering and response objects stay per request.
const CORE_TOOL_SECTIONS = CORE_TOOL_SECTION_ORDER.map(({ id, label }) => ({
  id,
  label,
  tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === id),
}));

function listCoreToolIdsForProfile(profile: ToolProfileId): string[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map(
    (tool) => tool.id,
  );
}

const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
  coding: {
    allow: [...listCoreToolIdsForProfile("coding"), "bundle-mcp"],
  },
  messaging: {
    allow: [...listCoreToolIdsForProfile("messaging"), "bundle-mcp"],
  },
  full: {
    allow: ["*"],
  },
};

function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    if (tool.includeInSectionGroup === false) {
      continue;
    }
    const groupId = `group:${tool.sectionId}`;
    const list = sectionToolMap.get(groupId) ?? [];
    list.push(tool.id);
    sectionToolMap.set(groupId, list);
  }
  const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map(
    (tool) => tool.id,
  );
  return {
    "group:openclaw": openclawTools,
    ...Object.fromEntries(sectionToolMap.entries()),
  };
}

/** Built-in core tool groups keyed by group id. */
export const CORE_TOOL_GROUPS = buildCoreToolGroupMap();

/** Profile options shown in model/tool configuration UIs. */
export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

/** Resolves the allow/deny policy for a built-in tool profile. */
export function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = CORE_TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved?.allow && !resolved?.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

/** Lists configurable core tools; per-run authorization belongs to runtime assembly. */
export function listCoreToolSections(params?: {
  swarmEnabled?: boolean;
  personalInstructionsEnabled?: boolean;
}): CoreToolSection[] {
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
        description: tool.description,
      })),
  })).filter((section) => section.tools.length > 0);
}

/** Lists built-in profile ids that include a core tool. */
export function resolveCoreToolProfiles(toolId: string): ToolProfileId[] {
  return [...(CORE_TOOL_BY_ID.get(toolId)?.profiles ?? [])];
}

/** Returns true when a tool id is a known core tool. */
export function isKnownCoreToolId(toolId: string): boolean {
  return CORE_TOOL_BY_ID.has(toolId);
}
