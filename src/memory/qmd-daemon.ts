import { spawn } from "node:child_process";
import type { ResolvedQmdDaemonConfig } from "./backend-config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory");

type DaemonState = "stopped" | "starting" | "ready" | "error";

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type QmdDaemonParams = {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  daemonConfig: ResolvedQmdDaemonConfig;
};

export interface QmdDaemonQueryResult {
  docid?: string;
  file?: string;
  title?: string;
  score?: number;
  snippet?: string;
  context?: string | null;
}

export class QmdDaemon {
  private state: DaemonState = "stopped";
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private queryMutex: Promise<void> = Promise.resolve();
  private sessionId: string | null = null;

  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly config: ResolvedQmdDaemonConfig;
  private readonly endpointUrls: string[];
  private activeEndpointUrl: string | null = null;

  constructor(params: QmdDaemonParams) {
    this.command = params.command;
    this.env = params.env;
    this.cwd = params.cwd;
    this.config = params.daemonConfig;
    this.endpointUrls = [
      `http://127.0.0.1:${this.config.port}/mcp`,
      `http://[::1]:${this.config.port}/mcp`,
    ];
  }

  isReady(): boolean {
    return this.state === "ready";
  }

  /** HTTP transport has no local orphan cleanup responsibility. */
  async cleanupOrphan(): Promise<void> {
    return;
  }

  /**
   * Keep method for manager compatibility. There is no exponential backoff in
   * HTTP mode; the manager retries once per query before falling back.
   */
  async waitForBackoff(): Promise<void> {
    return;
  }

  /** Verify daemon responsiveness with a lightweight MCP call. */
  async ensureHealthy(timeoutMs = 2_000): Promise<boolean> {
    if (!this.isReady()) {
      return false;
    }
    try {
      await this.rpcRequest("tools/list", undefined, { timeoutMs });
      return true;
    } catch (err) {
      log.warn(`qmd daemon health check failed: ${String(err)}`);
      this.state = "error";
      this.sessionId = null;
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.state === "ready") {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.state = "starting";

    try {
      const running = await this.probeEndpoint(Math.min(2_000, this.config.coldStartTimeoutMs));
      if (!running) {
        await this.runControlCommand(
          ["mcp", "--http", "--daemon", "--port", String(this.config.port)],
          this.config.coldStartTimeoutMs,
        );
      }
      await this.waitForHealthy(this.config.coldStartTimeoutMs);
      this.state = "ready";
      this.resetIdleTimer();
      log.info(`qmd daemon started (${this.activeEndpointUrl ?? this.endpointUrls[0]})`);
    } catch (err) {
      this.state = "error";
      this.sessionId = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.sessionId = null;
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopped";
    try {
      const stopTimeoutMs = Math.min(10_000, this.config.coldStartTimeoutMs);
      try {
        await this.runControlCommand(
          ["daemon", "stop", "--port", String(this.config.port)],
          stopTimeoutMs,
        );
      } catch {
        await this.runControlCommand(["mcp", "stop"], stopTimeoutMs);
      }
      log.info("qmd daemon stopped");
    } catch (err) {
      // Stopping a non-running daemon should not break shutdown.
      log.debug(`qmd daemon stop skipped/failed: ${String(err)}`);
    }
  }

  async query(
    text: string,
    opts: { tool: string; limit: number; collection?: string; timeoutMs: number },
  ): Promise<QmdDaemonQueryResult[]> {
    return await this.withQueryLock(async () => {
      if (!this.isReady()) {
        throw new Error("qmd daemon not ready");
      }

      this.clearIdleTimer();

      try {
        const result = await this.rpcRequest<{
          content?: Array<{ type: string; text?: string }>;
          structuredContent?: { results?: QmdDaemonQueryResult[] };
          isError?: boolean;
        }>(
          "tools/call",
          {
            name: opts.tool,
            arguments: {
              query: text,
              limit: opts.limit,
              ...(opts.collection ? { collection: opts.collection } : {}),
            },
          },
          { timeoutMs: opts.timeoutMs },
        );

        if (result?.isError) {
          const errText =
            Array.isArray(result.content) && result.content[0]?.type === "text"
              ? ((result.content[0] as { text?: string }).text ?? "unknown daemon error")
              : "unknown daemon error";
          throw new Error(`qmd daemon tool error: ${errText}`);
        }

        if (Array.isArray(result?.structuredContent?.results)) {
          return result.structuredContent.results;
        }

        if (Array.isArray(result?.content) && result.content.length > 0) {
          const first = result.content[0];
          if (first?.type === "text" && typeof first.text === "string") {
            try {
              const parsed: unknown = JSON.parse(first.text);
              if (Array.isArray(parsed)) {
                return parsed as QmdDaemonQueryResult[];
              }
            } catch {
              // Structured payload is preferred; ignore parse errors here.
            }
          }
        }

        return [];
      } finally {
        this.resetIdleTimer();
      }
    });
  }

  private async withQueryLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queryMutex;
    let release: () => void = () => undefined;
    this.queryMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async waitForHealthy(totalTimeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(1_000, totalTimeoutMs);
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const ok = await this.probeEndpoint(Math.min(2_000, deadline - Date.now()));
        if (ok) {
          return;
        }
      } catch (err) {
        lastErr = err;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`qmd daemon did not become healthy: ${formatError(lastErr ?? "timeout")}`);
  }

  private async probeEndpoint(timeoutMs: number): Promise<boolean> {
    try {
      await this.rpcRequest("tools/list", undefined, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  private async runControlCommand(
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.env,
        cwd: this.cwd,
      });
      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`qmd ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const exitCode = code ?? 0;
        if (exitCode !== 0) {
          const stderrText = stderr.trim();
          reject(
            new Error(
              stderrText ||
                `qmd ${args.join(" ")} exited with code ${exitCode}${stdout.trim() ? ` (${stdout.trim()})` : ""}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });
    });
  }

  private async rpcRequest<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;

    const attempt = async (sessionId?: string): Promise<{ data: T; sessionId: string | null }> => {
      const id = this.nextId++;
      const payload = { jsonrpc: "2.0", id, method, params: params ?? {} };
      const { response, parsed } = await this.fetchRpcJson(payload, timeoutMs, sessionId);
      if (parsed.error) {
        throw new Error(parsed.error.message ?? "qmd daemon rpc error");
      }
      const nextSessionId =
        response.headers.get("mcp-session-id") ??
        response.headers.get("Mcp-Session-Id") ??
        sessionId ??
        null;
      return { data: parsed.result as T, sessionId: nextSessionId };
    };

    if (method !== "initialize" && !this.sessionId) {
      await this.initializeSession(timeoutMs);
    }

    try {
      const result = await attempt(this.sessionId ?? undefined);
      this.sessionId = result.sessionId;
      return result.data;
    } catch (err) {
      if (method === "initialize") {
        throw err;
      }
      // Session could be stale after daemon restart; retry once with fresh initialize.
      this.sessionId = null;
      await this.initializeSession(timeoutMs);
      const result = await attempt(this.sessionId ?? undefined);
      this.sessionId = result.sessionId;
      return result.data;
    }
  }

  private async initializeSession(timeoutMs: number): Promise<void> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openclaw-qmd", version: "1.0.0" },
      },
    };

    const { response, parsed } = await this.fetchRpcJson(payload, timeoutMs);
    if (parsed.error) {
      throw new Error(parsed.error.message ?? "qmd daemon initialize error");
    }
    const sessionId =
      response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");
    if (!sessionId) {
      throw new Error("qmd daemon initialize missing session id");
    }
    this.sessionId = sessionId;
    await this.rpcNotify("notifications/initialized", undefined, timeoutMs, sessionId);
  }

  private async rpcNotify(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    sessionId: string,
  ): Promise<void> {
    const payload = { jsonrpc: "2.0", method, params: params ?? {} };
    await this.fetchRpcRaw(payload, timeoutMs, sessionId);
  }

  private async fetchRpcJson(
    payload: Record<string, unknown>,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<{ response: Response; parsed: JsonRpcResponse }> {
    const response = await this.fetchRpcRaw(payload, timeoutMs, sessionId);
    const parsed = (await response.json()) as JsonRpcResponse;
    return { response, parsed };
  }

  private async fetchRpcRaw(
    payload: Record<string, unknown>,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<Response> {
    let lastErr: Error | null = null;
    for (const endpointUrl of this.getEndpointCandidates()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpointUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`http ${response.status}`);
        }
        this.activeEndpointUrl = endpointUrl;
        return response;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          lastErr = new Error(
            `qmd daemon rpc timeout (${String(payload.method)}, ${timeoutMs}ms)`,
            {
              cause: err,
            },
          );
        } else {
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new Error("qmd daemon rpc failed");
  }

  private getEndpointCandidates(): string[] {
    if (this.activeEndpointUrl) {
      return [
        this.activeEndpointUrl,
        ...this.endpointUrls.filter((url) => url !== this.activeEndpointUrl),
      ];
    }
    return this.endpointUrls;
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    const timeout = this.config.idleTimeoutMs;
    if (timeout <= 0) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      log.info("qmd daemon idle timeout — shutting down");
      void this.stop();
    }, timeout);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
