import type { Writable } from "node:stream";

export type JsonRpcId = number | string;
export type JsonRpcRequestHandler = (params: unknown, signal: AbortSignal) => unknown;
export type JsonRpcNotificationHandler = (params: unknown) => void | Promise<void>;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};

type IncomingRequest = {
  controller: AbortController;
  timeout: NodeJS.Timeout;
};

export type JsonRpcPeerOptions = {
  write: Writable;
  requestTimeoutMs: number;
  maxPendingRequests: number;
  requestHandlers?: ReadonlyMap<string, JsonRpcRequestHandler>;
  notificationHandlers?: ReadonlyMap<string, JsonRpcNotificationHandler>;
  onProtocolError?: (message: string) => void;
};

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_INTERNAL_ERROR = -32603;
const JSON_RPC_SERVER_BUSY = -32000;
const JSON_RPC_REQUEST_TIMEOUT = -32001;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly incoming = new Map<JsonRpcId, IncomingRequest>();
  private closedError: Error | undefined;

  constructor(private readonly options: JsonRpcPeerOptions) {
    options.write.on("error", (error) => this.close(error));
  }

  request(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`JSON-RPC request aborted: ${method}`));
    }
    if (this.pending.size >= this.options.maxPendingRequests) {
      return Promise.reject(new Error("JSON-RPC pending request limit exceeded"));
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending?.signal && pending.abort) {
          pending.signal.removeEventListener("abort", pending.abort);
        }
        reject(new Error(`JSON-RPC request timed out: ${method}`));
        this.notify("$/cancelRequest", { id });
      }, timeoutMs);
      const abort = options.signal
        ? () => {
            clearTimeout(timeout);
            this.pending.delete(id);
            reject(new Error(`JSON-RPC request aborted: ${method}`));
            this.notify("$/cancelRequest", { id });
          }
        : undefined;
      options.signal?.addEventListener("abort", abort!, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        timeout,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(abort ? { abort } : {}),
      });
      try {
        this.write(
          { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
          (error) => {
            if (!error || !this.pending.has(id)) {
              return;
            }
            clearTimeout(timeout);
            this.pending.delete(id);
            if (options.signal && abort) {
              options.signal.removeEventListener("abort", abort);
            }
            reject(error);
          },
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        if (options.signal && abort) {
          options.signal.removeEventListener("abort", abort);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) {
      return;
    }
    try {
      this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      this.options.onProtocolError?.(
        `JSON-RPC notification write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  notifyAsync(method: string, params?: unknown): Promise<void> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    return new Promise((resolve, reject) => {
      this.write(
        { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          if (this.closedError) {
            reject(this.closedError);
            return;
          }
          resolve();
        },
      );
    });
  }

  handle(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== "2.0") {
      this.options.onProtocolError?.("Ignoring invalid JSON-RPC message");
      return;
    }
    if (isJsonRpcResponse(value)) {
      this.handleResponse(value);
      return;
    }
    if (isJsonRpcRequest(value)) {
      void this.handleRequest(value);
      return;
    }
    if (isJsonRpcNotification(value)) {
      void this.handleNotification(value);
      return;
    }
    this.options.onProtocolError?.("Ignoring unsupported JSON-RPC message");
  }

  close(error: Error): void {
    if (this.closedError) {
      return;
    }
    this.closedError = error;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      if (pending.signal && pending.abort) {
        pending.signal.removeEventListener("abort", pending.abort);
      }
      pending.reject(error);
    }
    this.pending.clear();
    for (const [, incoming] of this.incoming) {
      clearTimeout(incoming.timeout);
      incoming.controller.abort();
    }
    this.incoming.clear();
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
    if (response.error) {
      const error = new Error(response.error.message);
      Object.assign(error, { code: response.error.code, data: response.error.data });
      pending.reject(error);
      return;
    }
    pending.resolve(response.result);
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    if (this.closedError) {
      return;
    }
    if (this.incoming.has(request.id)) {
      this.writeError(request.id, JSON_RPC_INVALID_REQUEST, `Duplicate request id: ${request.id}`);
      return;
    }
    if (this.incoming.size >= this.options.maxPendingRequests) {
      this.writeError(request.id, JSON_RPC_SERVER_BUSY, "JSON-RPC incoming request limit exceeded");
      return;
    }
    const handler = this.options.requestHandlers?.get(request.method);
    if (!handler) {
      this.writeError(request.id, JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const incoming = this.incoming.get(request.id);
      if (incoming?.controller !== controller || this.closedError) {
        return;
      }
      this.incoming.delete(request.id);
      controller.abort();
      this.writeError(request.id, JSON_RPC_REQUEST_TIMEOUT, `JSON-RPC request timed out`);
    }, this.options.requestTimeoutMs);
    this.incoming.set(request.id, { controller, timeout });
    try {
      const result = await handler(request.params, controller.signal);
      if (!this.closedError && this.incoming.get(request.id)?.controller === controller) {
        this.write({ jsonrpc: "2.0", id: request.id, result: result ?? null });
      }
    } catch (error) {
      if (!this.closedError && this.incoming.get(request.id)?.controller === controller) {
        this.writeError(
          request.id,
          JSON_RPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      clearTimeout(timeout);
      if (this.incoming.get(request.id)?.controller === controller) {
        this.incoming.delete(request.id);
      }
    }
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (notification.method === "$/cancelRequest") {
      const id = isRecord(notification.params) ? notification.params.id : undefined;
      if (typeof id === "number" || typeof id === "string") {
        this.incoming.get(id)?.controller.abort();
      }
      return;
    }
    try {
      await this.options.notificationHandlers?.get(notification.method)?.(notification.params);
    } catch (error) {
      this.options.onProtocolError?.(
        `JSON-RPC notification handler failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(
    message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
    callback?: (error?: Error | null) => void,
  ): void {
    this.options.write.write(`${JSON.stringify(message)}\n`, callback);
  }
}

function isJsonRpcRequest(value: Record<string, unknown>): value is JsonRpcRequest {
  return (
    (typeof value.id === "number" || typeof value.id === "string") &&
    typeof value.method === "string"
  );
}

function isJsonRpcNotification(value: Record<string, unknown>): value is JsonRpcNotification {
  return value.id === undefined && typeof value.method === "string";
}

function isJsonRpcResponse(value: Record<string, unknown>): value is JsonRpcResponse {
  return (
    (typeof value.id === "number" || typeof value.id === "string") &&
    value.method === undefined &&
    ("result" in value || "error" in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
