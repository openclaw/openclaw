export const CORE_TOOL_DEFINITIONS = [
  { id: "read", sectionId: "fs", profiles: ["coding"] },
  { id: "write", sectionId: "fs", profiles: ["coding"] },
  { id: "edit", sectionId: "fs", profiles: ["coding"] },
  { id: "apply_patch", sectionId: "fs", profiles: ["coding"] },
  { id: "exec", sectionId: "runtime", profiles: ["coding"] },
  { id: "process", sectionId: "runtime", profiles: ["coding"] },
  { id: "web_search", sectionId: "web", profiles: [], includeInOpenClawGroup: true },
  { id: "web_fetch", sectionId: "web", profiles: [], includeInOpenClawGroup: true },
  { id: "memory_search", sectionId: "memory", profiles: ["coding"], includeInOpenClawGroup: true },
  { id: "memory_get", sectionId: "memory", profiles: ["coding"], includeInOpenClawGroup: true },
  {
    id: "sessions_list",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_history",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_send",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_spawn",
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  { id: "subagents", sectionId: "sessions", profiles: ["coding"], includeInOpenClawGroup: true },
  {
    id: "session_status",
    sectionId: "sessions",
    profiles: ["minimal", "coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  { id: "browser", sectionId: "ui", profiles: [], includeInOpenClawGroup: true },
  { id: "canvas", sectionId: "ui", profiles: [], includeInOpenClawGroup: true },
  { id: "message", sectionId: "messaging", profiles: ["messaging"], includeInOpenClawGroup: true },
  { id: "cron", sectionId: "automation", profiles: [], includeInOpenClawGroup: true },
  { id: "gateway", sectionId: "automation", profiles: [], includeInOpenClawGroup: true },
  { id: "nodes", sectionId: "nodes", profiles: [], includeInOpenClawGroup: true },
  { id: "agents_list", sectionId: "agents", profiles: [], includeInOpenClawGroup: true },
  { id: "image", sectionId: "media", profiles: ["coding"], includeInOpenClawGroup: true },
  { id: "tts", sectionId: "media", profiles: [], includeInOpenClawGroup: true },
];

function listCoreToolIdsForProfile(profile: string): string[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map(
    (tool) => tool.id,
  );
}

export const CORE_TOOL_PROFILES: Record<string, { allow?: string[]; deny?: string[] }> = {
  minimal: { allow: listCoreToolIdsForProfile("minimal") },
  coding: { allow: listCoreToolIdsForProfile("coding") },
  messaging: { allow: listCoreToolIdsForProfile("messaging") },
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
