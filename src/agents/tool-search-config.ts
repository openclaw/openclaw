import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolSearchConfig as AuthoredToolSearchConfig } from "../config/types.tools.js";
import { MAX_TOOL_SEARCH_RESULTS, type ToolSearchConfig } from "./tool-search-types.js";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 20;

export function resolveToolSearchConfig(config?: OpenClawConfig): ToolSearchConfig {
  const setting = config?.tools?.toolSearch;
  const raw: Exclude<AuthoredToolSearchConfig, boolean> =
    setting === undefined || typeof setting === "boolean" ? { enabled: setting ?? true } : setting;
  const configured = Object.keys(raw).some((key) => key !== "enabled");
  const maxSearchLimit = Math.min(
    MAX_TOOL_SEARCH_RESULTS,
    raw.maxSearchLimit ?? DEFAULT_MAX_SEARCH_LIMIT,
  );
  return {
    enabled: raw.enabled ?? configured,
    mode: raw.mode ?? "tools",
    searchDefaultLimit: Math.min(maxSearchLimit, raw.searchDefaultLimit ?? DEFAULT_SEARCH_LIMIT),
    maxSearchLimit,
    ...(raw.include !== undefined ? { include: raw.include } : {}),
    ...(raw.exclude !== undefined ? { exclude: raw.exclude } : {}),
  };
}
