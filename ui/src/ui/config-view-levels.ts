/**
 * Config view levels for filtering fields by complexity.
 * - Basic: Essential settings for getting started (~20 fields)
 * - Standard: Common settings for most users (~80 fields)
 * - Advanced: All settings including expert-only options (~260 fields)
 */

export type ConfigViewLevel = "basic" | "standard" | "advanced";

export const VIEW_LEVELS: Array<{ value: ConfigViewLevel; label: string; description: string }> = [
  { value: "basic", label: "Basic", description: "Essential settings only" },
  { value: "standard", label: "Standard", description: "Common settings" },
  { value: "advanced", label: "Advanced", description: "All settings" },
];

/**
 * Basic-level fields: Essential settings for getting started.
 * These are the minimum fields a new user needs.
 */
export const BASIC_FIELDS = new Set([
  // Models
  "models",
  "models.anthropic",
  "models.anthropic.apiKey",
  "models.openai",
  "models.openai.apiKey",

  // Agent basics
  "agents",
  "agents.defaults",
  "agents.defaults.model",
  "agents.defaults.model.primary",
  "agents.defaults.thinkingDefault",
  "agents.defaults.workspace",

  // Channels (top-level)
  "channels",
  "channels.telegram",
  "channels.discord",
  "channels.slack",
  "channels.whatsapp",

  // Gateway basics
  "gateway",
  "gateway.port",
  "gateway.mode",

  // Update channel
  "update",
  "update.channel",
]);

/**
 * Standard-level fields: Common settings most users will adjust.
 * Includes basic fields plus commonly-used options.
 */
export const STANDARD_SECTIONS = new Set([
  // All basic fields are included
  "models",
  "agents",
  "channels",
  "gateway",
  "update",

  // Additional standard sections
  "tools",
  "skills",
  "messages",
  "commands",
  "session",
  "logging",
  "audio",
]);

/**
 * Paths that are explicitly advanced-only even within standard sections.
 * These are hidden unless view level is "advanced".
 */
export const ADVANCED_ONLY_PATHS = new Set([
  // Diagnostics and debugging
  "diagnostics",
  "diagnostics.otel",
  "diagnostics.cacheTrace",

  // Expert agent settings
  "agents.defaults.contextPruning",
  "agents.defaults.compaction",
  "agents.defaults.sandbox",
  "agents.defaults.subagents",
  "agents.defaults.heartbeat",
  "agents.defaults.memorySearch",

  // Expert gateway settings
  "gateway.security",
  "gateway.rateLimit",
  "gateway.cors",
  "gateway.tls",

  // Browser advanced
  "browser.cdpUrl",
  "browser.remoteCdpTimeoutMs",
  "browser.remoteCdpHandshakeTimeoutMs",
  "browser.snapshotDefaults",
  "browser.profiles",

  // Internal
  "meta",
  "wizard",
  "env.shellEnv",
]);

/**
 * Check if a path should be shown at the given view level.
 * @param path - Dot-separated config path (e.g., "agents.defaults.model")
 * @param level - Current view level
 * @param isAdvancedHint - Whether the field has advanced: true in uiHints
 */
export function isPathVisibleAtLevel(
  path: string,
  level: ConfigViewLevel,
  isAdvancedHint: boolean = false,
): boolean {
  // Advanced level shows everything
  if (level === "advanced") {
    return true;
  }

  // Check if this path is explicitly advanced-only
  if (ADVANCED_ONLY_PATHS.has(path) || isAdvancedHint) {
    return false;
  }

  // For basic level, only show basic fields
  if (level === "basic") {
    // Check exact match
    if (BASIC_FIELDS.has(path)) return true;

    // Check if any parent or prefix matches
    const parts = path.split(".");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join(".");
      if (BASIC_FIELDS.has(prefix)) return true;
    }

    return false;
  }

  // Standard level: show if section is in standard sections
  const topLevel = path.split(".")[0];
  return STANDARD_SECTIONS.has(topLevel);
}

/**
 * Check if a section (top-level key) should be shown at the given view level.
 */
export function isSectionVisibleAtLevel(
  sectionKey: string,
  level: ConfigViewLevel,
): boolean {
  if (level === "advanced") return true;

  if (level === "basic") {
    return BASIC_FIELDS.has(sectionKey);
  }

  // Standard
  return STANDARD_SECTIONS.has(sectionKey);
}

/**
 * Get description for the current view level.
 */
export function getViewLevelDescription(level: ConfigViewLevel): string {
  const info = VIEW_LEVELS.find((l) => l.value === level);
  return info?.description ?? "";
}
