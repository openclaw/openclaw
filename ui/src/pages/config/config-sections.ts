export type ConfigPageId =
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "mcp"
  | "infrastructure"
  | "ai-agents";

export const COMMUNICATION_SECTION_KEYS = [
  "messages",
  "broadcast",
  "__notifications__",
  "talk",
  "audio",
  "channels",
] as const;

export const APPEARANCE_SECTION_KEYS = ["__appearance__", "ui", "wizard"] as const;

export const AUTOMATION_SECTION_KEYS = [
  "commands",
  "hooks",
  "bindings",
  "cron",
  "approvals",
  "plugins",
] as const;

export const INFRASTRUCTURE_SECTION_KEYS = [
  "gateway",
  "web",
  "browser",
  "nodeHost",
  "canvasHost",
  "discovery",
  "media",
  "acp",
  "mcp",
] as const;

export const AI_AGENTS_SECTION_KEYS = [
  "agents",
  "models",
  "skills",
  "tools",
  "memory",
  "session",
] as const;

export const SCOPED_CONFIG_SECTION_KEYS = new Set<string>([
  ...COMMUNICATION_SECTION_KEYS,
  ...APPEARANCE_SECTION_KEYS,
  ...AUTOMATION_SECTION_KEYS,
  ...INFRASTRUCTURE_SECTION_KEYS,
  ...AI_AGENTS_SECTION_KEYS,
]);

export function configSectionKeysForPage(pageId: ConfigPageId): readonly string[] | undefined {
  switch (pageId) {
    case "communications":
      return COMMUNICATION_SECTION_KEYS;
    case "appearance":
      return APPEARANCE_SECTION_KEYS;
    case "automation":
      return AUTOMATION_SECTION_KEYS;
    case "mcp":
    case "infrastructure":
      return INFRASTRUCTURE_SECTION_KEYS;
    case "ai-agents":
      return AI_AGENTS_SECTION_KEYS;
    case "config":
      return undefined;
  }
}
