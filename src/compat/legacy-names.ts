export const PROJECT_NAME = "openclaw" as const;

/**
 * Legacy project names for backwards compatibility.
 * Plugins published before the OpenClaw rename may use these manifest keys.
 * - "clawdbot": Used in Clawdbot era (pre-2026)
 * - "moltbot": Used in Moltbot era (early 2026)
 */
export const LEGACY_PROJECT_NAMES = ["clawdbot", "moltbot"] as const;

export const MANIFEST_KEY = PROJECT_NAME;

export const LEGACY_MANIFEST_KEYS = LEGACY_PROJECT_NAMES;

export const LEGACY_PLUGIN_MANIFEST_FILENAMES = [] as const;

export const LEGACY_CANVAS_HANDLER_NAMES = [] as const;

export const MACOS_APP_SOURCES_DIR = "apps/macos/Sources/OpenClaw" as const;

export const LEGACY_MACOS_APP_SOURCES_DIRS = [] as const;
