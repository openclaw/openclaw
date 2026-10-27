import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { GatewayClientRequestError } from "../gateway/client.js";
import type { GatewayClientRequestOptions } from "../gateway/client.js";
import { createPendingRequestRegistry } from "../shared/pending-request-registry.js";
import type { NodeHostClient } from "./client.js";
import type { NodeHostGatewayConnection } from "./connection.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

type NodeHostWorkerGatewayResponse = { generation: number } & (
  | { type: "gateway-response"; id: string; ok: true; result: unknown }
  | { type: "gateway-response"; id: string; ok: false; error: { code: string; message: string } }
);

type NodeHostWorkerInput =
  | { type: "gateway-connection"; generation: number; connection: NodeHostGatewayConnection | null }
  | { type: "invoke"; generation: number; request: NodeInvokeRequestPayload }
  | { type: "invoke-input"; generation: number; invokeId: string; seq: number; payloadJSON: string }
  | { type: "invoke-cancel"; generation: number; invokeId: string }
  | { type: "runner-inventory-refresh"; generation: number }
  | NodeHostWorkerGatewayResponse
  | { type: "stop" };

export function parseNodeHostWorkerInput(line: string): NodeHostWorkerInput | null {
  try {
    // The app-owned stdin pipe carries typed frames from this same runtime build.
    return JSON.parse(line) as NodeHostWorkerInput;
  } catch {
    return null;
  }
}

export class NodeHostWorkerBridgeClient implements NodeHostClient {
  private nextRequestId = 1;
  private generation = 0;
  private connected = false;
  private readonly invocationGeneration = new AsyncLocalStorage<number>();

  setConnection(generation: number, connected: boolean): void {
    this.pending.rejectAll(new Error("node-host Gateway route changed"));
    this.generation = generation;
    this.connected = connected;
  }

  withConnection<T>(generation: number, run: () => T): T {
    return this.invocationGeneration.run(generation, run);
  }
  private readonly pending = createPendingRequestRegistry<string, unknown, undefined>();

  constructor(private readonly writeMessage: (message: unknown) => void) {}

  async request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    opts?.signal?.throwIfAborted();
    const generation = this.invocationGeneration.getStore() ?? this.generation;
    if (!this.connected || generation !== this.generation) {
      throw new Error("node-host Gateway route is closed");
    }
    if (method === "node.invoke.result") {
      this.writeMessage({ type: "invoke-result", generation, result: params ?? {} });
      return {} as T;
    }
    if (method === "node.event") {
      this.writeMessage({ type: "node-event", generation, event: params ?? {} });
      return {} as T;
    }

    const id = `gateway-${this.nextRequestId++}`;
    const timeoutMs = resolveTimerTimeoutMs(opts?.timeoutMs, 15_000);
    const signal = opts?.signal;
    const onAbort = () => this.pending.take(id)?.reject(signal?.reason);
    const pending = this.pending.add(id, {
      value: undefined,
      timeoutMs,
      timeoutError: () => new Error(`Gateway request timed out: ${method}`),
      dispose: () => signal?.removeEventListener("abort", onAbort),
    });
    if (!pending) {
      throw new Error(`Gateway request id collision: ${id}`);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    this.writeMessage({
      type: "gateway-request",
      generation,
      id,
      method,
      params: params ?? {},
      timeoutMs,
    });
    return (await pending.promise) as T;
  }

  handleResponse(message: NodeHostWorkerGatewayResponse): boolean {
    if (message.generation !== this.generation) {
      return false;
    }
    const pending = this.pending.take(message.id);
    if (!pending) {
      return false;
    }
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new GatewayClientRequestError({ code: message.error.code, message: message.error.message }),
      );
    }
    return true;
  }

  close(): void {
    this.connected = false;
    this.pending.rejectAll(new Error("node-host worker stopped"));
  }
}

export async function stopNodeHostWorkerFromSignal(
  input: { close(): void },
  stop: (exitCode: number) => Promise<void>,
  exitCode: number,
): Promise<void> {
  const stopped = stop(exitCode);
  input.close();
  await stopped;
}
