// Renders tool definitions and tool-search catalog entries in LLM format.
// ~49% token savings vs compact JSON. Phase 7.

import { toLlmFormat } from "@openclaw/llm-core/llm-format";

/** Renders a tool definition in LLM format. */
export function toolToLlmFormat(tool: {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}): string {
  const parts: string[] = [
    `tool.${tool.name ?? "unnamed"}.description="${tool.description ?? ""}"`,
  ];
  if (
    tool.parameters &&
    typeof tool.parameters === "object" &&
    Object.keys(tool.parameters).length > 0
  ) {
    const paramStr = toLlmFormat(tool.parameters);
    parts.push(`tool.${tool.name ?? "unnamed"}.schema={${paramStr.replace(/\n/g, "\n  ")}}`);
  }
  return parts.join("\n");
}

/** Renders multiple tools in LLM format with a section header. */
export function toolsToLlmFormat(
  tools: Array<{
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>,
): string {
  if (tools.length === 0) return "";
  const sections = tools.map((t) => toolToLlmFormat(t));
  return `[tools]\n${sections.join("\n")}`;
}

/** Renders a tool-search catalog entry in LLM format. */
export function catalogEntryToLlmFormat(entry: {
  name: string;
  description?: string;
  source?: string;
}): string {
  const lines: string[] = [];
  lines.push(`catalog.${entry.name}.description="${entry.description ?? ""}"`);
  if (entry.source) lines.push(`catalog.${entry.name}.source="${entry.source}"`);
  return lines.join("\n");
}

/** Renders multiple catalog entries in LLM format. */
export function catalogToLlmFormat(
  entries: Array<{
    name: string;
    description?: string;
    source?: string;
  }>,
): string {
  if (entries.length === 0) return "catalog=[]";
  const sections = entries.map((e) => catalogEntryToLlmFormat(e));
  return `[catalog]\n${sections.join("\n")}`;
}
