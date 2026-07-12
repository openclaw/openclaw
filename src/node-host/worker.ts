/** Private JSONL worker exposing the CLI node-host runtime to the macOS app. */
import { createInterface } from "node:readline";
import type { GatewayClientRequestOptions } from "../gateway/client.js";
import { VERSION } from "../version.js";
import type { NodeHostClient } from "./client.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";
import {
  prepareNodeHostRuntime,
  type ActiveNodeHostRuntime,
  type NodeHostInventory,
} from "./runtime.js";

type WorkerInput =
  | { type: "invoke"; request: NodeInvokeRequestPayload }
  | { type: "gateway-response"; id: string; ok: true; result: unknown }
  | { type: "gateway-response"; id: string; ok: false; error: string }
  | { type: "stop" };

type PendingGatewayRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class NodeHostWorkerBridgeClient implements NodeHostClient {
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingGatewayRequest>();

  constructor(private readonly writeMessage: (message: unknown) => void) {}

  async request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    if (method === "node.invoke.result") {
      this.writeMessage({ type: "invoke-result", result: params ?? {} });
      return {} as T;
    }
    if (method === "node.event") {
      this.writeMessage({ type: "node-event", event: params ?? {} });
      return {} as T;
    }

    const id = `gateway-${this.nextRequestId++}`;
    const timeoutMs = Math.max(1, opts?.timeoutMs ?? 15_000);
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.writeMessage({ type: "gateway-request", id, method, params: params ?? {}, timeoutMs });
    return (await response) as T;
  }

  handleResponse(message: Extract<WorkerInput, { type: "gateway-response" }>): boolean {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return false;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error));
    }
    return true;
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("node-host worker stopped"));
    }
    this.pending.clear();
  }
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseInput(line: string): WorkerInput | null {
  try {
    const parsed = asRecord(JSON.parse(line));
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if (type === "invoke") {
      const request = asRecord(parsed?.request);
      if (
        request &&
        typeof request.id === "string" &&
        typeof request.nodeId === "string" &&
        typeof request.command === "string"
      ) {
        return { type, request: request as NodeInvokeRequestPayload };
      }
      return null;
    }
    if (type === "gateway-response") {
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      if (!id) {
        return null;
      }
      return parsed?.ok === true
        ? { type, id, ok: true, result: parsed.result }
        : {
            type,
            id,
            ok: false,
            error: typeof parsed?.error === "string" ? parsed.error : "Gateway request failed",
          };
    }
    return type === "stop" ? { type } : null;
  } catch {
    return null;
  }
}

function emitInventory(inventory: NodeHostInventory): void {
  writeMessage({ type: "inventory", inventory });
}

export async function stopNodeHostWorkerFromSignal(
  input: Pick<ReturnType<typeof createInterface>, "close">,
  stop: (exitCode: number) => Promise<void>,
  exitCode: number,
): Promise<void> {
  const stopped = stop(exitCode);
  input.close();
  await stopped;
}

export async function runNodeHostWorker(): Promise<void> {
  const prepared = await prepareNodeHostRuntime();
  const client = new NodeHostWorkerBridgeClient(writeMessage);
  let runtime: ActiveNodeHostRuntime | undefined;
  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const stop = async (exitCode: number) => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      client.close();
      await runtime?.close();
      process.exitCode = exitCode;
    } finally {
      resolveStopped?.();
    }
  };

  runtime = prepared.start({ client, onInventoryChanged: emitInventory });
  writeMessage({
    type: "ready",
    version: VERSION,
    manifest: prepared.manifest,
    inventory: prepared.initialInventory,
  });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const message = parseInput(line);
    if (!message) {
      writeMessage({ type: "protocol-error", error: "invalid worker request" });
      return;
    }
    if (message.type === "gateway-response") {
      client.handleResponse(message);
      return;
    }
    if (message.type === "stop") {
      input.close();
      void stop(0);
      return;
    }
    void runtime?.invoke(message.request);
  });
  input.on("close", () => void stop(0));
  process.once("SIGINT", () => void stopNodeHostWorkerFromSignal(input, stop, 130));
  process.once("SIGTERM", () => void stopNodeHostWorkerFromSignal(input, stop, 143));
  await stopped;
}
