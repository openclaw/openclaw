import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeServerName, TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import { readToolResultStatus, resolveToolResultFailureKind } from "./tool-result-error.js";

export const TOOL_USAGE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
export const TOOL_USAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type ToolUsageRow = { toolId: string; score: number; updatedAt: number };
export type ToolUsageCatalogEntry = { id: string; name: string };

export function decayToolUsage(row: ToolUsageRow, at: number): number {
  return row.score * 2 ** (-Math.max(0, at - row.updatedAt) / TOOL_USAGE_HALF_LIFE_MS);
}

/** Both contributions retain the timestamp of the most recent successful call. */
export function mergeToolUsage(a: ToolUsageRow, b: ToolUsageRow): ToolUsageRow {
  if (a.toolId !== b.toolId) {
    throw new Error("Cannot merge usage for different tools");
  }
  const updatedAt = Math.max(a.updatedAt, b.updatedAt);
  return {
    toolId: a.toolId,
    score: decayToolUsage(a, updatedAt) + decayToolUsage(b, updatedAt),
    updatedAt,
  };
}

export type ToolUsageExclusion = "errors" | "cancelled" | "pending" | "incognito" | "notExecuted";
export type ToolUsageOutcome = {
  isError: boolean;
  result?: unknown;
  cancelled?: boolean;
  incognito?: boolean;
  executionStarted?: boolean;
};

/** Shared by terminal runtime observations and transcript import. */
export function classifyToolUsage(input: ToolUsageOutcome): ToolUsageExclusion | undefined {
  if (input.incognito) {
    return "incognito";
  }
  if (input.cancelled) {
    return "cancelled";
  }
  if (input.executionStarted === false) {
    return "notExecuted";
  }
  const failure = resolveToolResultFailureKind(input.result);
  if (failure === "cancelled") {
    return "cancelled";
  }
  if (input.isError || failure) {
    return "errors";
  }
  const status = readToolResultStatus(input.result);
  return status === "running" ||
    status === "started" ||
    status === "queued" ||
    status === "pending" ||
    status === "approval-pending" ||
    status === "skipped" ||
    status === "waiting"
    ? "pending"
    : undefined;
}

export function successfulToolUsage(input: ToolUsageOutcome): boolean {
  return classifyToolUsage(input) === undefined;
}

const wrappers = new Set([
  "dispatch_action",
  "tool_search",
  "tool_describe",
  "code_mode",
  "mcp_exec",
]);

export function isToolUsageWrapper(name: string): boolean {
  return wrappers.has(name);
}

const MCP_TOOL_USAGE_ID_RE = /^mcp:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,128})$/u;

/** The bare tool name of a self-describing `mcp:<server>:<tool>` catalog ID. */
export function readMcpToolUsageIdName(id: string): string | undefined {
  return MCP_TOOL_USAGE_ID_RE.exec(id)?.[2];
}

/**
 * History records MCP calls by bare name; the result's `mcpServer` detail, set by
 * OpenClaw's MCP runtime, names the server. Accepted edge case: a server whose
 * safe name needed a collision suffix does not match and stays uncounted.
 */
function resolveMcpToolUsageId(name: string, result: unknown): string | undefined {
  const details = asOptionalRecord(asOptionalRecord(result)?.details);
  if (typeof details?.mcpServer !== "string") {
    return undefined;
  }
  const server = sanitizeServerName(details.mcpServer, new Set());
  const id = `mcp:${server}:${name}`;
  return name.startsWith(`${server}${TOOL_NAME_SEPARATOR}`) && MCP_TOOL_USAGE_ID_RE.test(id)
    ? id
    : undefined;
}

/**
 * Names resolve only when unique; exact catalog IDs never depend on catalog order.
 * Exact MCP IDs name their own server, so they resolve without a live MCP catalog.
 * A bare name resolves from its MCP result evidence; when that evidence contradicts
 * a catalog owner of the same name, the call stays uncounted.
 */
export function createToolUsageCatalogResolver(catalog: readonly ToolUsageCatalogEntry[]) {
  const ids = new Set<string>();
  const names = new Map<string, string | null>();
  for (const entry of catalog) {
    if (isToolUsageWrapper(entry.name)) {
      continue;
    }
    const eligible = entry.id.startsWith("openclaw:") || entry.id.startsWith("mcp:");
    if (eligible) {
      ids.add(entry.id);
    }
    names.set(
      entry.name,
      !eligible || (names.has(entry.name) && names.get(entry.name) !== entry.id) ? null : entry.id,
    );
  }
  return (idOrName: string, result?: unknown): string | undefined => {
    if (ids.has(idOrName) || readMcpToolUsageIdName(idOrName) !== undefined) {
      return idOrName;
    }
    const mcpId = resolveMcpToolUsageId(idOrName, result);
    if (!names.has(idOrName)) {
      return mcpId;
    }
    const known = names.get(idOrName) ?? undefined;
    return mcpId && known !== mcpId ? undefined : known;
  };
}
