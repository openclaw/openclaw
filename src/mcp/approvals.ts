/**
 * MCP tool approval gate.
 *
 * Provides an approval workflow for MCP tools, allowing server operators
 * to require human approval before certain MCP tools execute.
 *
 * Config example:
 * ```json5
 * {
 *   mcp: {
 *     servers: {
 *       "dangerous-server": {
 *         command: "npx",
 *         args: ["-y", "@dangerous/mcp-server"],
 *         approval: "always"         // require approval for ALL tools
 *       },
 *       "mixed-server": {
 *         command: "npx",
 *         args: ["-y", "@mixed/mcp-server"],
 *         approval: "allowlist",     // require approval unless in list
 *         approvedTools: ["read_file", "list_dir"]
 *       }
 *     }
 *   }
 * }
 * ```
 */

import { defaultRuntime } from "../runtime.js";
import type { McpApprovalMode, McpServerConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpApprovalDecision = "allow" | "deny" | "timeout";

export type McpApprovalRequest = {
  id: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
};

export type McpApprovalResult = {
  decision: McpApprovalDecision;
  request: McpApprovalRequest;
};

/**
 * Function type for an approval handler that resolves approval decisions.
 * Implementations may prompt a user via CLI, gateway IPC, or auto-resolve.
 */
export type McpApprovalHandler = (
  request: McpApprovalRequest,
) => Promise<McpApprovalDecision>;

// ---------------------------------------------------------------------------
// Approval check
// ---------------------------------------------------------------------------

/**
 * Determine whether an MCP tool call requires approval based on server config.
 */
export function requiresMcpApproval(
  serverConfig: McpServerConfig,
  toolName: string,
): boolean {
  const mode = resolveApprovalMode(serverConfig);

  switch (mode) {
    case "none":
      return false;
    case "always":
      return true;
    case "allowlist": {
      const approved = serverConfig.approvedTools ?? [];
      return !approved.includes(toolName);
    }
  }
}

/**
 * Resolve the approval mode for a server.
 *
 * Defaults to "none" when unset. If set to an unrecognized value,
 * defaults to "always" (fail-closed) and logs a warning.
 */
export function resolveApprovalMode(serverConfig: McpServerConfig): McpApprovalMode {
  const raw = serverConfig.approval;
  if (raw === undefined) {
    return "none";
  }
  if (raw === "always" || raw === "allowlist" || raw === "none") {
    return raw;
  }
  // Fail-closed: an unrecognized approval mode should not silently disable approvals.
  defaultRuntime.error(
    `[mcp:approvals] Unknown approval mode "${String(raw)}" — defaulting to "always" for safety`,
  );
  return "always";
}

// ---------------------------------------------------------------------------
// In-memory approval manager (mirrors ExecApprovalManager pattern)
// ---------------------------------------------------------------------------

type PendingApproval = {
  request: McpApprovalRequest;
  resolve: (decision: McpApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Manages pending MCP approval requests.
 * Mirrors the gateway ExecApprovalManager pattern — register a request,
 * get back a promise that blocks until a decision arrives or times out.
 */
export class McpApprovalManager {
  private pending = new Map<string, PendingApproval>();
  private defaultTimeoutMs: number;

  constructor(opts?: { defaultTimeoutMs?: number }) {
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 60_000;
  }

  /**
   * Register an approval request and return a promise for the decision.
   */
  register(request: McpApprovalRequest, timeoutMs?: number): Promise<McpApprovalDecision> {
    // Clean up existing if somehow reused.
    this.cancel(request.id);

    return new Promise<McpApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        resolve("timeout");
      }, timeoutMs ?? this.defaultTimeoutMs);

      this.pending.set(request.id, { request, resolve, timer });
    });
  }

  /**
   * Resolve a pending approval with a decision.
   */
  resolve(requestId: string, decision: McpApprovalDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
  }

  /**
   * Cancel a pending approval request.
   */
  cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      entry.resolve("deny");
    }
  }

  /**
   * Get a pending approval request by ID.
   */
  get(requestId: string): McpApprovalRequest | undefined {
    return this.pending.get(requestId)?.request;
  }

  /**
   * List all pending approval requests.
   */
  listPending(): McpApprovalRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }

  /**
   * Cancel all pending requests.
   */
  clear(): void {
    for (const [id] of this.pending) {
      this.cancel(id);
    }
  }

  /**
   * Number of pending approval requests.
   */
  get size(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton manager instance
// ---------------------------------------------------------------------------

let globalManager: McpApprovalManager | null = null;

export function getMcpApprovalManager(): McpApprovalManager {
  if (!globalManager) {
    globalManager = new McpApprovalManager();
  }
  return globalManager;
}

export function resetMcpApprovalManagerForTest(): void {
  globalManager?.clear();
  globalManager = null;
}
