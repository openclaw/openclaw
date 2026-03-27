/**
 * Brain MCP Client for OpenClaw
 *
 * Connects to Brain MCP via mcporter CLI (MCP protocol).
 * Makes REAL MCP calls - no mocks or stubs.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createSubsystemLogger } from "../logging/subsystem.js";

const execAsync = promisify(exec);
const log = createSubsystemLogger("brain-mcp");

export type BrainMemory = {
  memory_id: string;
  content: string;
  workspace_id: string;
  memory_type: string;
  relevance_score: number;
  created_at: string;
  metadata?: Record<string, unknown>;
};

export type BrainSearchResult = {
  results: BrainMemory[];
  total_count: number;
  query_processing?: {
    original_query: string;
    processed_query?: string;
  };
  performance_metrics?: {
    total_duration_ms: number;
  };
};

export type BrainQuickSearchResult = {
  results: Array<{
    memory_id: string;
    preview: string;
    similarity_score: number;
    workspace_id: string;
  }>;
  result_count: number;
  total_duration_ms: number;
};

export type BrainMcpClientConfig = {
  /**
   * Path to mcporter binary (default: "mcporter")
   */
  mcporterPath?: string;

  /**
   * Request timeout in milliseconds
   */
  timeoutMs: number;
};

/**
 * Client for Brain MCP server via mcporter.
 *
 * Uses mcporter CLI to make MCP calls.
 */
export class BrainMcpClient {
  private readonly mcporterPath: string;
  private readonly timeoutMs: number;

  constructor(config: BrainMcpClientConfig) {
    this.mcporterPath = config.mcporterPath ?? "mcporter";
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Tier 1: Quick search - fast, lightweight results.
   * Target: <100ms
   */
  async quickSearch(params: {
    query: string;
    workspaceId: string;
    limit?: number;
  }): Promise<BrainQuickSearchResult> {
    const startTime = Date.now();

    try {
      const args = [
        `query="${this.escapeArg(params.query)}"`,
        `workspace_id="${params.workspaceId}"`,
        `limit:${params.limit ?? 5}`,
      ];

      const result = await this.callTool("brain.quick_search", args);
      const duration = Date.now() - startTime;
      log.debug(`quick_search completed in ${duration}ms`);

      return this.parseQuickSearchResult(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      log.warn(`quick_search failed after ${duration}ms: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Tier 2/3: Unified search - comprehensive results.
   * Target: <500ms (semantic) / <3000ms (full)
   */
  async unifiedSearch(params: {
    query: string;
    workspaceId: string;
    mode?: "semantic" | "unified";
    limit?: number;
    includeRelationships?: boolean;
  }): Promise<BrainSearchResult> {
    const startTime = Date.now();

    try {
      // Build search_request as JSON string
      const searchRequest = JSON.stringify({
        workspace_id: params.workspaceId,
        mode: params.mode ?? "semantic",
        limit: params.limit ?? 10,
        include_relationships: params.includeRelationships ?? false,
      });

      const args = [`query="${this.escapeArg(params.query)}"`, `search_request='${searchRequest}'`];

      const result = await this.callTool("brain.unified_search", args);
      const duration = Date.now() - startTime;
      log.debug(`unified_search (${params.mode}) completed in ${duration}ms`);

      return this.parseUnifiedSearchResult(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      log.warn(`unified_search failed after ${duration}ms: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Tier 2: Smart search - vector + graph + rerank, no LLM rewrite.
   * Target: ~200ms Brain-side, ~1s via mcporter
   */
  async smartSearch(params: {
    query: string;
    workspaceId: string;
    limit?: number;
  }): Promise<BrainSearchResult> {
    const startTime = Date.now();

    try {
      const args = [
        `query="${this.escapeArg(params.query)}"`,
        `workspace_id="${params.workspaceId}"`,
        `limit:${params.limit ?? 10}`,
      ];

      const result = await this.callTool("brain.smart_search", args);
      const duration = Date.now() - startTime;
      log.debug(`smart_search completed in ${duration}ms`);

      return this.parseUnifiedSearchResult(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      log.warn(`smart_search failed after ${duration}ms: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Create a memory in a workspace.
   */
  async createMemory(params: {
    content: string;
    workspaceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const memoryJson = JSON.stringify([
      {
        content: params.content,
        metadata: params.metadata ?? {},
      },
    ]);

    const args = [
      `memories='${memoryJson.replace(/'/g, "'\\''")}'`,
      `workspace_id="${params.workspaceId}"`,
    ];

    await this.callTool("brain.create_memories", args);
  }

  /**
   * Health check - verify Brain MCP is available.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.callTool("brain.health_check", []);
      const isHealthy = result.includes("healthy") || result.includes("connected");
      log.debug(`healthCheck result: ${isHealthy}, output length: ${result.length}`);
      return isHealthy;
    } catch (error) {
      log.debug(`healthCheck failed: ${String(error)}`);
      return false;
    }
  }

  /**
   * Call a Brain MCP tool via mcporter.
   */
  private async callTool(selector: string, args: string[]): Promise<string> {
    const command = `${this.mcporterPath} call ${selector} ${args.join(" ")}`;

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large results
      });

      if (stderr && !stderr.includes("warn")) {
        log.debug(`mcporter stderr: ${stderr}`);
      }

      return stdout;
    } catch (error) {
      if (error instanceof Error && error.message.includes("ETIMEDOUT")) {
        throw new Error(`Brain MCP request timed out after ${this.timeoutMs}ms`, { cause: error });
      }
      throw error;
    }
  }

  /**
   * Escape argument for shell command.
   */
  private escapeArg(arg: string): string {
    // Escape double quotes and backslashes
    return arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /**
   * Parse quick_search result from mcporter output.
   */
  private parseQuickSearchResult(output: string): BrainQuickSearchResult {
    try {
      // mcporter outputs JSON
      const parsed = JSON.parse(output);
      return {
        results: parsed.results ?? [],
        result_count: parsed.result_count ?? parsed.results?.length ?? 0,
        total_duration_ms: parsed.total_duration_ms ?? 0,
      };
    } catch {
      // If not JSON, return empty results
      log.debug(`Could not parse quick_search output as JSON: ${output.slice(0, 200)}`);
      return { results: [], result_count: 0, total_duration_ms: 0 };
    }
  }

  /**
   * Parse unified_search result from mcporter output.
   */
  private parseUnifiedSearchResult(output: string): BrainSearchResult {
    try {
      const parsed = JSON.parse(output);
      return {
        results: parsed.results ?? [],
        total_count: parsed.total_count ?? parsed.results?.length ?? 0,
        query_processing: parsed.query_processing,
        performance_metrics: parsed.performance_metrics,
      };
    } catch {
      log.debug(`Could not parse unified_search output as JSON: ${output.slice(0, 200)}`);
      return { results: [], total_count: 0 };
    }
  }
}

/**
 * Create a Brain MCP client instance.
 */
export function createBrainMcpClient(config: BrainMcpClientConfig): BrainMcpClient {
  return new BrainMcpClient(config);
}
