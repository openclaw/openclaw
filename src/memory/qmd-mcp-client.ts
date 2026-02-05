/**
 * QMD MCP Client
 *
 * Manages a long-lived `qmd mcp` subprocess using the Model Context Protocol.
 * Provides persistent connection to QMD's search capabilities, eliminating
 * the ~7s cold-start penalty for query operations.
 *
 * @see TECHNICAL-SPEC.md for architecture details
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mcp");

// ============================================================================
// Type Conversion Helpers
// ============================================================================

/** Convert unknown to string, with fallback for non-primitives */
function toString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

/** Convert unknown to string or undefined (for optional fields) */
function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

// ============================================================================
// Types
// ============================================================================

export type QmdMcpClientState = "stopped" | "starting" | "running" | "failed";

export interface QmdMcpConfig {
  /** QMD command (e.g., "qmd") */
  command: string;
  /** Environment variables for the subprocess */
  env: Record<string, string>;
  /** Working directory for the subprocess */
  cwd: string;
  /** Maximum time to wait for MCP server initialization (ms) */
  startupTimeoutMs: number;
  /** Per-request timeout (ms) - allows for model loading on first query */
  requestTimeoutMs: number;
  /** Maximum restart attempts before giving up */
  maxRetries: number;
  /** Delay between restart attempts (ms) */
  retryDelayMs: number;
}

export interface QmdMcpSearchResult {
  docid: string;
  file: string;
  title?: string;
  score: number;
  context?: string | null;
  snippet?: string;
  body?: string;
}

export interface QmdMcpDocument {
  docid: string;
  file: string;
  title?: string;
  content: string;
}

export interface QmdMcpQueryOptions {
  limit?: number;
  minScore?: number;
  collection?: string;
}

export interface QmdMcpSearchOptions {
  limit?: number;
}

export interface QmdMcpGetOptions {
  /** File path or docid (e.g., "#abc123") */
  path: string;
}

// Default configuration values
const DEFAULT_CONFIG: Partial<QmdMcpConfig> = {
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  maxRetries: 3,
  retryDelayMs: 1_000,
};

// ============================================================================
// QmdMcpClient
// ============================================================================

export class QmdMcpClient extends EventEmitter {
  private readonly config: QmdMcpConfig;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private state: QmdMcpClientState = "stopped";
  private retryCount = 0;
  private startPromise: Promise<void> | null = null;

  constructor(config: Partial<QmdMcpConfig> & Pick<QmdMcpConfig, "command" | "env" | "cwd">) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as QmdMcpConfig;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Returns the current state of the MCP client.
   */
  getState(): QmdMcpClientState {
    return this.state;
  }

  /**
   * Returns true if the client is connected and ready for queries.
   */
  isRunning(): boolean {
    return this.state === "running";
  }

  /**
   * Returns true if the client has failed and exhausted retries.
   */
  isFailed(): boolean {
    return this.state === "failed" && this.retryCount >= this.config.maxRetries;
  }

  /**
   * Starts the MCP client by spawning `qmd mcp` and initializing the connection.
   * If already starting, waits for the existing start to complete.
   * If already running, returns immediately.
   */
  async start(): Promise<void> {
    if (this.state === "running") {
      return;
    }

    // If already starting, wait for the existing start promise
    if (this.state === "starting" && this.startPromise) {
      return this.startPromise;
    }

    this.state = "starting";
    this.startPromise = this.doStart();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    try {
      log.debug(`Starting qmd mcp (attempt ${this.retryCount + 1}/${this.config.maxRetries + 1})`);

      // Create the stdio transport which spawns the subprocess
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: ["mcp"],
        env: this.config.env,
        cwd: this.config.cwd,
      });

      // Create the MCP client
      this.client = new Client(
        {
          name: "openclaw",
          version: "1.0.0",
        },
        {
          capabilities: {},
        },
      );

      // Set up error handling for transport close
      // MCP SDK uses callback properties, not DOM events
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      this.transport.onclose = () => {
        if (this.state === "running") {
          log.warn("MCP transport closed unexpectedly");
          this.state = "failed";
          this.emit("error", new Error("MCP transport closed unexpectedly"));
        }
      };

      // eslint-disable-next-line unicorn/prefer-add-event-listener
      this.transport.onerror = (err) => {
        log.warn(`MCP transport error: ${err.message}`);
        if (this.state === "running") {
          this.state = "failed";
          this.emit("error", err);
        }
      };

      // Connect with timeout
      const connectPromise = this.client.connect(this.transport);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`MCP startup timeout after ${this.config.startupTimeoutMs}ms`)),
          this.config.startupTimeoutMs,
        );
      });

      await Promise.race([connectPromise, timeoutPromise]);

      this.state = "running";
      this.retryCount = 0;
      log.debug("MCP client connected successfully");
      this.emit("started");
    } catch (err) {
      this.state = "failed";
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`MCP client startup failed: ${message}`);

      // Clean up any partial state
      await this.cleanup();

      this.emit("error", err);
      throw err;
    }
  }

  /**
   * Gracefully closes the MCP client and subprocess.
   */
  async close(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }

    log.debug("Closing MCP client");
    await this.cleanup();
    this.state = "stopped";
    this.retryCount = 0;
    log.debug("MCP client closed");
  }

  private async cleanup(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        log.debug(`Error closing MCP client: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.client = null;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch (err) {
        log.debug(
          `Error closing MCP transport: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.transport = null;
    }
  }

  // --------------------------------------------------------------------------
  // Connection Management
  // --------------------------------------------------------------------------

  /**
   * Ensures the client is connected, restarting if necessary.
   * Throws if max retries exceeded.
   */
  private async ensureConnected(): Promise<Client> {
    if (this.state === "running" && this.client) {
      return this.client;
    }

    if (this.state === "failed") {
      if (this.retryCount >= this.config.maxRetries) {
        throw new Error(`MCP client failed after ${this.config.maxRetries} retries`);
      }

      // Wait before retry
      this.retryCount++;
      log.debug(`MCP client retry ${this.retryCount}/${this.config.maxRetries}`);
      await new Promise((r) => setTimeout(r, this.config.retryDelayMs));
    }

    await this.start();

    if (!this.client) {
      throw new Error("MCP client not initialized after start");
    }

    return this.client;
  }

  // --------------------------------------------------------------------------
  // Tool Calls
  // --------------------------------------------------------------------------

  /**
   * Hybrid search with reranking (highest quality).
   * Uses embedding model + reranker. First call may be slow (~7s) to load models.
   */
  async query(queryText: string, opts?: QmdMcpQueryOptions): Promise<QmdMcpSearchResult[]> {
    await this.ensureConnected();

    const args: Record<string, unknown> = {
      query: queryText,
    };

    if (opts?.limit !== undefined) {
      args.limit = opts.limit;
    }
    if (opts?.minScore !== undefined) {
      args.minScore = opts.minScore;
    }
    if (opts?.collection !== undefined) {
      args.collection = opts.collection;
    }

    log.debug(`MCP query: "${queryText.slice(0, 50)}..." (limit=${opts?.limit ?? 10})`);

    const result = await this.callToolWithTimeout("query", args);
    return this.extractSearchResults(result);
  }

  /**
   * BM25 full-text search (fast, no model loading).
   */
  async search(queryText: string, opts?: QmdMcpSearchOptions): Promise<QmdMcpSearchResult[]> {
    await this.ensureConnected();

    const args: Record<string, unknown> = {
      query: queryText,
    };

    if (opts?.limit !== undefined) {
      args.limit = opts.limit;
    }

    log.debug(`MCP search: "${queryText.slice(0, 50)}..." (limit=${opts?.limit ?? 10})`);

    const result = await this.callToolWithTimeout("search", args);
    return this.extractSearchResults(result);
  }

  /**
   * Vector semantic search (uses embedding model only).
   */
  async vsearch(queryText: string, opts?: QmdMcpQueryOptions): Promise<QmdMcpSearchResult[]> {
    await this.ensureConnected();

    const args: Record<string, unknown> = {
      query: queryText,
    };

    if (opts?.limit !== undefined) {
      args.limit = opts.limit;
    }
    if (opts?.minScore !== undefined) {
      args.minScore = opts.minScore;
    }
    if (opts?.collection !== undefined) {
      args.collection = opts.collection;
    }

    log.debug(`MCP vsearch: "${queryText.slice(0, 50)}..." (limit=${opts?.limit ?? 10})`);

    const result = await this.callToolWithTimeout("vsearch", args);
    return this.extractSearchResults(result);
  }

  /**
   * Get a document by path or docid.
   */
  async get(pathOrDocid: string): Promise<QmdMcpDocument | null> {
    await this.ensureConnected();

    log.debug(`MCP get: "${pathOrDocid}"`);

    const result = await this.callToolWithTimeout("get", { path: pathOrDocid });
    return this.extractDocument(result);
  }

  /**
   * Get index status information.
   */
  async status(): Promise<Record<string, unknown>> {
    await this.ensureConnected();

    log.debug("MCP status");

    const result = await this.callToolWithTimeout("status", {});

    // Status returns structured content directly
    if (result && typeof result === "object" && "structuredContent" in result) {
      const structured = (result as { structuredContent?: unknown }).structuredContent;
      if (structured && typeof structured === "object") {
        return structured as Record<string, unknown>;
      }
    }

    return {};
  }

  // --------------------------------------------------------------------------
  // Internal Helpers
  // --------------------------------------------------------------------------

  private async callToolWithTimeout(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected();

    const callPromise = client.callTool({ name, arguments: args });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(`MCP request "${name}" timed out after ${this.config.requestTimeoutMs}ms`),
          ),
        this.config.requestTimeoutMs,
      );
    });

    try {
      return await Promise.race([callPromise, timeoutPromise]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`MCP tool call "${name}" failed: ${message}`);
      throw err;
    }
  }

  private extractSearchResults(result: unknown): QmdMcpSearchResult[] {
    // MCP tool results have structuredContent with results array
    if (!result || typeof result !== "object") {
      return [];
    }

    const response = result as { structuredContent?: { results?: unknown[] }; content?: unknown[] };

    // Try structuredContent first (preferred)
    if (response.structuredContent?.results && Array.isArray(response.structuredContent.results)) {
      return response.structuredContent.results.map((r) => this.normalizeSearchResult(r));
    }

    // Fallback: try to parse from text content
    if (response.content && Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item && typeof item === "object" && "type" in item && item.type === "text") {
          const text = (item as { text?: string }).text;
          if (text) {
            try {
              const parsed = JSON.parse(text);
              if (Array.isArray(parsed)) {
                return parsed.map((r) => this.normalizeSearchResult(r));
              }
            } catch {
              // Not JSON, ignore
            }
          }
        }
      }
    }

    return [];
  }

  private normalizeSearchResult(raw: unknown): QmdMcpSearchResult {
    const item = raw as Record<string, unknown>;
    return {
      docid: toString(item.docid),
      file: toString(item.file),
      title: toStringOrUndefined(item.title),
      score: typeof item.score === "number" ? item.score : 0,
      context: toStringOrUndefined(item.context) ?? null,
      snippet: toStringOrUndefined(item.snippet),
      body: toStringOrUndefined(item.body),
    };
  }

  private extractDocument(result: unknown): QmdMcpDocument | null {
    if (!result || typeof result !== "object") {
      return null;
    }

    const response = result as { structuredContent?: { document?: unknown }; content?: unknown[] };

    // Try structuredContent first
    if (response.structuredContent?.document) {
      const doc = response.structuredContent.document as Record<string, unknown>;
      return {
        docid: toString(doc.docid),
        file: toString(doc.file),
        title: toStringOrUndefined(doc.title),
        content: toString(doc.content),
      };
    }

    // Fallback: try to get content from text
    if (response.content && Array.isArray(response.content)) {
      for (const item of response.content) {
        if (item && typeof item === "object" && "type" in item && item.type === "text") {
          const text = (item as { text?: string }).text;
          if (text) {
            return {
              docid: "",
              file: "",
              content: text,
            };
          }
        }
      }
    }

    return null;
  }
}
