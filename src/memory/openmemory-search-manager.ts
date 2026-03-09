import fs from "node:fs/promises";
import path from "node:path";
import { OpenMemoryClient, type MemorySector } from "./openmemory-client.js";
import { isMemoryPath } from "./internal.js";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemoryEmbeddingProbeResult,
} from "./types.js";

export interface OpenMemorySearchManagerOptions {
  url: string;
  userId?: string;
  timeout?: number;
  agentId: string;
  workspaceDir?: string;
}

/**
 * Memory search manager that delegates to an OpenMemory server instance.
 * Implements MemorySearchManager interface for integration with OpenClaw's
 * memory_search and memory_get tools.
 */
export class OpenMemorySearchManager implements MemorySearchManager {
  private client: OpenMemoryClient;
  private agentId: string;
  private workspaceDir: string;
  private serverUrl: string;

  constructor(options: OpenMemorySearchManagerOptions) {
    this.serverUrl = options.url;
    this.client = new OpenMemoryClient({
      url: options.url,
      userId: options.userId ?? options.agentId,
      timeout: options.timeout,
    });
    this.agentId = options.agentId;
    this.workspaceDir = options.workspaceDir ?? process.cwd();
  }

  /**
   * Search memories via OpenMemory server
   */
  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      temporal?: {
        startTime?: number;
        endTime?: number;
        sector?: MemorySector;
      };
    },
  ): Promise<MemorySearchResult[]> {
    return this.client.search(query, opts);
  }

  /**
   * Read a file from the local filesystem.
   * OpenMemory stores memories, not files, so we read from disk.
   * Enforces path restrictions: must be within workspace and in memory directory.
   */
  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const { relPath, from, lines } = params;

    const rawPath = relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }

    // Resolve path relative to workspace
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);

    // Security: enforce path restrictions (same as builtin manager)
    const resolvedRelPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    const inWorkspace =
      resolvedRelPath.length > 0 &&
      !resolvedRelPath.startsWith("..") &&
      !path.isAbsolute(resolvedRelPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(resolvedRelPath);

    if (!allowedWorkspace) {
      throw new Error("path must be within memory directory (memory/*.md or MEMORY.md)");
    }

    // Only allow .md files
    if (!absPath.endsWith(".md")) {
      throw new Error("path must be a .md file");
    }

    const content = await fs.readFile(absPath, "utf-8");
    const allLines = content.split("\n");

    // Apply line slicing if requested
    const startLine = from ?? 1;
    const startIndex = Math.max(0, startLine - 1);
    const endIndex = lines !== undefined ? startIndex + lines : allLines.length;

    const slicedLines = allLines.slice(startIndex, endIndex);
    const text = slicedLines.join("\n");

    return { text, path: relPath };
  }

  /**
   * Return status information about this memory backend
   */
  status(): MemoryProviderStatus {
    return {
      backend: "openmemory",
      provider: "openmemory",
      workspaceDir: this.workspaceDir,
      custom: {
        agentId: this.agentId,
        serverUrl: this.serverUrl,
      },
    };
  }

  /**
   * OpenMemory handles embeddings server-side
   */
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return this.client.probeEmbeddingAvailability();
  }

  /**
   * Vector search is available if the server is reachable
   */
  async probeVectorAvailability(): Promise<boolean> {
    return this.client.probeVectorAvailability();
  }

  /**
   * Cleanup (no persistent resources to release)
   */
  async close(): Promise<void> {
    // No cleanup needed - OpenMemoryClient is stateless
  }
}
