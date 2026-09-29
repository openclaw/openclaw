import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  MAX_TOOL_SEARCH_RESULTS,
  type ToolSearchConfig,
  type ToolSearchMode,
} from "./tool-search-types.js";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 20;

function readToolSearchConfig(config?: OpenClawConfig): Record<string, unknown> {
  const tools = isRecord(config?.tools) ? config.tools : undefined;
  const toolSearch = tools?.toolSearch;
  if (toolSearch === undefined || toolSearch === true) {
    return { enabled: true };
  }
  if (toolSearch === false) {
    return { enabled: false };
  }
  return isRecord(toolSearch) ? toolSearch : {};
}

function readInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveToolSearchConfig(config?: OpenClawConfig): ToolSearchConfig {
  const raw = readToolSearchConfig(config);
  const mode: ToolSearchMode = raw.mode === "directory" ? "directory" : "tools";
  const configured = Object.keys(raw).some((key) => key !== "enabled");
  const maxSearchLimit = Math.min(
    MAX_TOOL_SEARCH_RESULTS,
    readInteger(raw.maxSearchLimit, DEFAULT_MAX_SEARCH_LIMIT),
  );
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : configured,
    mode,
    searchDefaultLimit: Math.min(
      maxSearchLimit,
      readInteger(raw.searchDefaultLimit, DEFAULT_SEARCH_LIMIT),
    ),
    maxSearchLimit,
  };
}

/**
 * True only when the operator wrote `tools.toolSearch` and it resolves enabled. Harness
 * runtimes with their own deferral (Claude CLI via bundle MCP) opt in on this signal so the
 * implicit embedded default does not change their eager tool loading.
 */
export function isToolSearchExplicitlyEnabled(config?: OpenClawConfig): boolean {
  const tools = isRecord(config?.tools) ? config.tools : undefined;
  if (tools?.toolSearch === undefined) {
    return false;
  }
  return resolveToolSearchConfig(config).enabled;
}
