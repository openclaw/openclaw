export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

export type CoreToolSection = {
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
  label: string;
  description: string;
  sectionId: string;
  profiles: ToolProfileId[];
  includeInOpenClawGroup?: boolean;
};

/**
 * Tool section registry.
 *
 * Each section `id` becomes a tool group usable in `tools.allow` / `tools.deny`
 * as `"group:<sectionId>"`. For example:
 *
 *   "tools": { "allow": ["group:fs", "group:task", "group:milestone"] }
 *
 * Adding a new section here + corresponding entries in CORE_TOOL_DEFINITIONS
 * is sufficient to make the group resolvable across the entire policy pipeline.
 */
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
  { id: "task", label: "Task Management" },
  { id: "milestone", label: "Milestones" },
];

const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  {
    id: "read",
    label: "read",
    description: "Read file contents",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "write",
    label: "write",
    description: "Create or overwrite files",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "edit",
    label: "edit",
    description: "Make precise edits",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "apply_patch",
    label: "apply_patch",
    description: "Patch files (OpenAI)",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "exec",
    label: "exec",
    description: "Run shell commands",
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "process",
    label: "process",
    description: "Manage background processes",
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "web_search",
    label: "web_search",
    description: "Search the web",
    sectionId: "web",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "web_fetch",
    label: "web_fetch",
    description: "Fetch web content",
    sectionId: "web",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_search",
    label: "memory_search",
    description: "Semantic search",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_get",
    label: "memory_get",
    description: "Read memory files",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_list",
    label: "sessions_list",
    description: "List sessions",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_history",
    label: "sessions_history",
    description: "Session history",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_send",
    label: "sessions_send",
    description: "Send to session",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_spawn",
    label: "sessions_spawn",
    description: "Spawn sub-agent",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "subagents",
    label: "subagents",
    description: "Manage sub-agents",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "session_status",
    label: "session_status",
    description: "Session status",
    sectionId: "sessions",
    profiles: ["minimal", "coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "browser",
    label: "browser",
    description: "Control web browser",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "canvas",
    label: "canvas",
    description: "Control canvases",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "message",
    label: "message",
    description: "Send messages",
    sectionId: "messaging",
    profiles: ["messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "cron",
    label: "cron",
    description: "Schedule tasks",
    sectionId: "automation",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "gateway",
    label: "gateway",
    description: "Gateway control",
    sectionId: "automation",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "nodes",
    label: "nodes",
    description: "Nodes + devices",
    sectionId: "nodes",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "agents_list",
    label: "agents_list",
    description: "List agents",
    sectionId: "agents",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "image",
    label: "image",
    description: "Image understanding",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "tts",
    label: "tts",
    description: "Text-to-speech conversion",
    sectionId: "media",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  // ── Task Management (group:task) ─────────────────────────────────
  // These entries register task tools created by openclaw-tools.ts
  // (via task-crud.ts / task-tool.ts) into the core tool catalog so that
  // `"group:task"` in openclaw.json tools.allow resolves correctly.
  // Without these, agents cannot use any task_* tools.
  {
    id: "task_start",
    label: "task_start",
    description: "Start a new task",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_update",
    label: "task_update",
    description: "Update task progress",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_complete",
    label: "task_complete",
    description: "Complete a task",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_status",
    label: "task_status",
    description: "Get task status",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_list",
    label: "task_list",
    description: "List tasks",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_cancel",
    label: "task_cancel",
    description: "Cancel a task",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_approve",
    label: "task_approve",
    description: "Approve a pending task",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_block",
    label: "task_block",
    description: "Mark task as blocked",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_resume",
    label: "task_resume",
    description: "Resume a blocked task",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_backlog_add",
    label: "task_backlog_add",
    description: "Add task to backlog",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_pick_backlog",
    label: "task_pick_backlog",
    description: "Pick task from backlog",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "task_verify",
    label: "task_verify",
    description: "Verify task completion",
    sectionId: "task",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  // ── Milestones (group:milestone) ─────────────────────────────────
  // Registered so `"group:milestone"` in tools.allow resolves.
  // Actual tools created by milestone-tool.ts in openclaw-tools.ts.
  {
    id: "milestone_list",
    label: "milestone_list",
    description: "List milestones",
    sectionId: "milestone",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "milestone_create",
    label: "milestone_create",
    description: "Create a milestone",
    sectionId: "milestone",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "milestone_add_item",
    label: "milestone_add_item",
    description: "Add item to milestone",
    sectionId: "milestone",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "milestone_assign_item",
    label: "milestone_assign_item",
    description: "Assign milestone item",
    sectionId: "milestone",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "milestone_update_item",
    label: "milestone_update_item",
    description: "Update milestone item",
    sectionId: "milestone",
    profiles: [],
    includeInOpenClawGroup: true,
  },
];

const CORE_TOOL_BY_ID = new Map<string, CoreToolDefinition>(
  CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

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
    allow: listCoreToolIdsForProfile("coding"),
  },
  messaging: {
    allow: listCoreToolIdsForProfile("messaging"),
  },
  full: {},
};

function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
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

export const CORE_TOOL_GROUPS = buildCoreToolGroupMap();

export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

export function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = CORE_TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) {
    return undefined;
  }
  if (!resolved.allow && !resolved.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

export function listCoreToolSections(): CoreToolSection[] {
  return CORE_TOOL_SECTION_ORDER.map((section) => ({
    id: section.id,
    label: section.label,
    tools: CORE_TOOL_DEFINITIONS.filter((tool) => tool.sectionId === section.id).map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: tool.description,
    })),
  })).filter((section) => section.tools.length > 0);
}

export function resolveCoreToolProfiles(toolId: string): ToolProfileId[] {
  const tool = CORE_TOOL_BY_ID.get(toolId);
  if (!tool) {
    return [];
  }
  return [...tool.profiles];
}

export function isKnownCoreToolId(toolId: string): boolean {
  return CORE_TOOL_BY_ID.has(toolId);
}
