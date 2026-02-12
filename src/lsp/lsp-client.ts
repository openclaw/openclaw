/**
 * LSP JSON-RPC client over stdio.
 *
 * Implements the Language Server Protocol's base protocol:
 * - JSON-RPC 2.0 over stdio
 * - Content-Length header framing
 * - Request/response correlation
 * - Notification handling
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("lsp/client");

export type LspMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type LspDiagnostic = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number; // 1=Error, 2=Warning, 3=Information, 4=Hint
  code?: number | string;
  source?: string;
  message: string;
  relatedInformation?: Array<{
    location: {
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    };
    message: string;
  }>;
};

export type LspHoverResult = {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

export type LspLocation = {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

export type DiagnosticsCallback = (uri: string, diagnostics: LspDiagnostic[]) => void;

const SEVERITY_MAP: Record<number, string> = {
  1: "Error",
  2: "Warning",
  3: "Information",
  4: "Hint",
};

export function diagnosticSeverityLabel(severity?: number): string {
  return severity ? (SEVERITY_MAP[severity] ?? "Unknown") : "Unknown";
}

/**
 * JSON-RPC client for LSP communication over stdio.
 */
export class LspClient extends EventEmitter {
  private process: ChildProcess;
  private nextId = 1;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = "";
  private contentLength = -1;
  private _onDiagnostics: DiagnosticsCallback | null = null;

  constructor(
    childProcess: ChildProcess,
    private readonly requestTimeoutMs = 30_000,
  ) {
    super();
    this.process = childProcess;

    if (!childProcess.stdout || !childProcess.stdin) {
      throw new Error("LSP process must have stdio pipes");
    }

    childProcess.stdout.on("data", (chunk: Buffer) => {
      this.handleData(chunk.toString("utf8"));
    });

    childProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        log.debug(`LSP stderr: ${text}`);
      }
    });

    childProcess.on("exit", (code, signal) => {
      log.debug(`LSP process exited: code=${code} signal=${signal}`);
      this.rejectAllPending(new Error(`LSP process exited (code=${code}, signal=${signal})`));
      this.emit("exit", code, signal);
    });

    childProcess.on("error", (err) => {
      log.warn(`LSP process error: ${err.message}`);
      this.rejectAllPending(err);
      this.emit("error", err);
    });
  }

  set onDiagnostics(cb: DiagnosticsCallback | null) {
    this._onDiagnostics = cb;
  }

  /**
   * Send an LSP request and wait for the response.
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message: LspMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timed out: ${method} (id=${id})`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.send(message);
    });
  }

  /**
   * Send an LSP notification (no response expected).
   */
  notify(method: string, params?: unknown): void {
    const message: LspMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.send(message);
  }

  /**
   * Check if the underlying process is alive.
   */
  isAlive(): boolean {
    return this.process.exitCode === null && !this.process.killed;
  }

  /**
   * Kill the underlying LSP process.
   */
  kill(): void {
    if (this.isAlive()) {
      this.process.kill("SIGTERM");
      // Force kill after 5s if still alive
      setTimeout(() => {
        if (this.isAlive()) {
          this.process.kill("SIGKILL");
        }
      }, 5_000);
    }
    this.rejectAllPending(new Error("LSP client killed"));
  }

  private send(message: LspMessage): void {
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    const stdin = this.process.stdin;
    if (!stdin || stdin.destroyed) {
      log.warn("Cannot send LSP message: stdin destroyed");
      return;
    }
    stdin.write(header + json);
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Parse Content-Length headers and JSON-RPC messages
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          break;
        }
        const header = this.buffer.slice(0, headerEnd);
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          log.warn(`Invalid LSP header: ${header}`);
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        this.contentLength = Number.parseInt(match[1], 10);
        this.buffer = this.buffer.slice(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) {
        break;
      }

      const body = this.buffer.slice(0, this.contentLength);
      this.buffer = this.buffer.slice(this.contentLength);
      this.contentLength = -1;

      try {
        const message = JSON.parse(body) as LspMessage;
        this.handleMessage(message);
      } catch (err) {
        log.warn(`Failed to parse LSP message: ${String(err)}`);
      }
    }
  }

  private handleMessage(message: LspMessage): void {
    // Response to a request
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(`LSP error (${message.error.code}): ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Notification from server
    if (message.method) {
      this.emit("notification", message.method, message.params);

      // Handle publishDiagnostics specifically
      if (message.method === "textDocument/publishDiagnostics" && this._onDiagnostics) {
        const params = message.params as {
          uri: string;
          diagnostics: LspDiagnostic[];
        };
        if (params?.uri && Array.isArray(params.diagnostics)) {
          this._onDiagnostics(params.uri, params.diagnostics);
        }
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }
}
