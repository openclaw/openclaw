import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import type { JsonRpcPeer } from "./json-rpc-peer.js";
import type { OpenClawPluginApi } from "./types.js";

export const JSON_RPC_PLUGIN_PROTOCOL_VERSION = 1;

type RpcReference = { $rpc: string; timeoutMs?: number };
type CallbackReference = { $callback: string };
type StreamReference = { $stream: string };
type AbortSignalReference = { $abortSignal: true; aborted?: boolean };
type BytesReference = { $bytes: string };

type StreamState = {
  values: unknown[];
  waiters: Array<() => void>;
  done: boolean;
  error?: Error;
};

const MAX_BUFFERED_STREAM_VALUES = 256;
const MAX_LOCAL_CALLBACKS = 1024;
const MAX_STREAMS = 256;
const MAX_WIRE_VALUE_DEPTH = 32;

export class JsonRpcPluginProtocol {
  private nextCallbackId = 1;
  private nextStreamId = 1;
  private readonly localCallbacks = new Map<string, (...args: unknown[]) => unknown>();
  private readonly remoteStreams = new Map<string, StreamState>();
  private readonly publishedStreams = new Map<string, AsyncIterable<unknown>>();
  private readonly activePublishedStreams = new Map<string, AsyncIterator<unknown>>();

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly hostPermissions: ReadonlySet<string>,
    private readonly getPeer: () => JsonRpcPeer,
    private readonly requestRemote: (
      method: string,
      params: unknown,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ) => Promise<unknown> = (method, params, options) =>
      this.getPeer().request(method, params, options),
  ) {}

  readonly requestHandlers = new Map([
    ["openclaw.host.call", (params: unknown, signal: AbortSignal) => this.callHost(params, signal)],
    [
      "openclaw.callback.invoke",
      (params: unknown, signal: AbortSignal) => this.invokeCallback(params, signal),
    ],
  ]);

  readonly notificationHandlers = new Map([
    ["$/callback/release", (params: unknown) => this.releaseCallback(params)],
    ["$/stream/chunk", (params: unknown) => this.handleStreamChunk(params)],
    ["$/stream/end", (params: unknown) => this.handleStreamEnd(params)],
    ["$/stream/error", (params: unknown) => this.handleStreamError(params)],
    ["$/stream/ready", (params: unknown) => this.startPublishedStream(params)],
    ["$/stream/cancel", (params: unknown) => this.cancelPublishedStream(params)],
  ]);

  materialize(value: unknown, signal?: AbortSignal): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.materialize(entry, signal));
    }
    if (!isRecord(value)) {
      return value;
    }
    if (isRpcReference(value)) {
      return async (...args: unknown[]) => {
        const abortSignal = findAbortSignal(args);
        const serializedArgs = args.map((arg) => this.serialize(arg));
        return await this.materialize(
          await this.requestRemote(
            value.$rpc,
            { args: serializedArgs },
            { timeoutMs: value.timeoutMs, signal: abortSignal },
          ),
        );
      };
    }
    if (isCallbackReference(value)) {
      return async (...args: unknown[]) => {
        const abortSignal = findAbortSignal(args);
        return this.materialize(
          await this.requestRemote(
            "openclaw.callback.invoke",
            {
              id: value.$callback,
              args: args.map((arg) => this.serialize(arg)),
            },
            { signal: abortSignal },
          ),
        );
      };
    }
    if (isStreamReference(value)) {
      return this.consumeRemoteStream(value.$stream);
    }
    if (isAbortSignalReference(value)) {
      return signal ?? AbortSignal.abort();
    }
    if (isBytesReference(value)) {
      return Buffer.from(value.$bytes, "base64");
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, this.materialize(entry, signal)]),
    );
  }

  serialize(value: unknown): unknown {
    return this.serializeValue(value, 0, new WeakSet());
  }

  dispose(error = new Error("JSON-RPC plugin protocol was disposed")): void {
    this.localCallbacks.clear();
    this.publishedStreams.clear();
    for (const [, iterator] of this.activePublishedStreams) {
      void iterator.return?.();
    }
    this.activePublishedStreams.clear();
    for (const [, state] of this.remoteStreams) {
      state.error = error;
      state.done = true;
      wakeStream(state);
    }
    this.remoteStreams.clear();
  }

  private serializeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (depth > MAX_WIRE_VALUE_DEPTH) {
      throw new Error("JSON-RPC wire value depth limit exceeded");
    }
    if (typeof value === "function") {
      if (this.localCallbacks.size >= MAX_LOCAL_CALLBACKS) {
        throw new Error("JSON-RPC retained callback limit exceeded");
      }
      const id = `host-callback-${this.nextCallbackId++}`;
      this.localCallbacks.set(id, value as (...args: unknown[]) => unknown);
      return { $callback: id } satisfies CallbackReference;
    }
    if (isAbortSignal(value)) {
      return { $abortSignal: true, aborted: value.aborted } satisfies AbortSignalReference;
    }
    if (isAsyncIterable(value)) {
      return this.publishStream(value);
    }
    if (value instanceof Readable) {
      return this.publishStream(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.serializeValue(entry, depth + 1, seen));
    }
    if (!isRecord(value)) {
      return value ?? null;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { $bytes: Buffer.from(value).toString("base64") } satisfies BytesReference;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
      };
    }
    if (seen.has(value)) {
      throw new Error("JSON-RPC wire value contains a cycle");
    }
    seen.add(value);
    const result = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        this.serializeValue(entry, depth + 1, seen),
      ]),
    );
    seen.delete(value);
    return result;
  }

  private async callHost(params: unknown, signal: AbortSignal): Promise<unknown> {
    if (!isRecord(params) || typeof params.method !== "string") {
      throw new Error("openclaw.host.call requires a method");
    }
    if (!this.hostPermissions.has(params.method)) {
      throw new Error(`host capability not permitted: ${params.method}`);
    }
    const target = resolveApiMethod(this.api, params.method);
    const args = Array.isArray(params.args)
      ? params.args.map((arg) => this.materialize(arg, signal))
      : [];
    if (target.acceptsSignal) {
      args.push(signal);
    }
    return this.serialize(await target.call(...args));
  }

  private async invokeCallback(params: unknown, signal: AbortSignal): Promise<unknown> {
    if (!isRecord(params) || typeof params.id !== "string") {
      throw new Error("openclaw.callback.invoke requires an id");
    }
    const callback = this.localCallbacks.get(params.id);
    if (!callback) {
      throw new Error(`unknown callback: ${params.id}`);
    }
    const args = Array.isArray(params.args)
      ? params.args.map((arg) => this.materialize(arg, signal))
      : [];
    return this.serialize(await callback(...args));
  }

  private publishStream(iterable: AsyncIterable<unknown>): StreamReference {
    if (this.publishedStreams.size + this.activePublishedStreams.size >= MAX_STREAMS) {
      throw new Error("JSON-RPC published stream limit exceeded");
    }
    const id = `host-stream-${this.nextStreamId++}`;
    this.publishedStreams.set(id, iterable);
    return { $stream: id };
  }

  private startPublishedStream(params: unknown): void {
    if (!isRecord(params) || typeof params.id !== "string") {
      return;
    }
    const iterable = this.publishedStreams.get(params.id);
    if (!iterable) {
      return;
    }
    const id = params.id;
    const iterator = iterable[Symbol.asyncIterator]();
    this.publishedStreams.delete(id);
    this.activePublishedStreams.set(id, iterator);
    void (async () => {
      try {
        while (this.activePublishedStreams.get(id) === iterator) {
          const next = await iterator.next();
          if (next.done) {
            break;
          }
          const chunk = next.value;
          await this.notifyRemote("$/stream/chunk", { id, chunk: this.serialize(chunk) });
        }
        if (this.activePublishedStreams.get(id) === iterator) {
          await this.notifyRemote("$/stream/end", { id });
        }
      } catch (error) {
        if (this.activePublishedStreams.get(id) === iterator) {
          try {
            await this.notifyRemote("$/stream/error", {
              id,
              message: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // The transport failure that stopped the stream is already owned by the peer.
          }
        }
      } finally {
        if (this.activePublishedStreams.get(id) === iterator) {
          this.activePublishedStreams.delete(id);
        }
      }
    })();
  }

  private async notifyRemote(method: string, params: unknown): Promise<void> {
    await this.getPeer().notifyAsync(method, params);
  }

  private consumeRemoteStream(id: string): AsyncIterable<unknown> {
    if (this.remoteStreams.has(id)) {
      throw new Error(`duplicate remote stream: ${id}`);
    }
    if (this.remoteStreams.size >= MAX_STREAMS) {
      throw new Error("JSON-RPC remote stream limit exceeded");
    }
    const state: StreamState = { values: [], waiters: [], done: false };
    this.remoteStreams.set(id, state);
    void this.notifyRemote("$/stream/ready", { id }).catch((error: unknown) => {
      state.error = error instanceof Error ? error : new Error(String(error));
      state.done = true;
      this.remoteStreams.delete(id);
      wakeStream(state);
    });
    const remoteStreams = this.remoteStreams;
    const cancelRemoteStream = () => this.notifyRemote("$/stream/cancel", { id });
    const wait = () =>
      new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (!state.done || state.values.length > 0) {
            if (state.values.length === 0) {
              await wait();
              continue;
            }
            yield state.values.shift();
          }
          if (state.error) {
            throw state.error;
          }
        } finally {
          remoteStreams.delete(id);
          if (!state.done) {
            void cancelRemoteStream().catch(() => undefined);
          }
        }
      },
    };
  }

  private cancelPublishedStream(params: unknown): void {
    if (!isRecord(params) || typeof params.id !== "string") {
      return;
    }
    this.publishedStreams.delete(params.id);
    const iterator = this.activePublishedStreams.get(params.id);
    if (!iterator) {
      return;
    }
    this.activePublishedStreams.delete(params.id);
    void iterator.return?.();
  }

  private handleStreamChunk(params: unknown): void {
    const state = streamStateFor(this.remoteStreams, params);
    if (!state || !isRecord(params)) {
      return;
    }
    if (state.values.length >= MAX_BUFFERED_STREAM_VALUES) {
      state.error = new Error("remote stream buffer limit exceeded");
      state.done = true;
      this.remoteStreams.delete(params.id as string);
      void this.notifyRemote("$/stream/cancel", { id: params.id }).catch(() => undefined);
      wakeStream(state);
      return;
    }
    state.values.push(this.materialize(params.chunk));
    wakeStream(state);
  }

  private handleStreamEnd(params: unknown): void {
    const state = streamStateFor(this.remoteStreams, params);
    if (!state) {
      return;
    }
    state.done = true;
    if (isRecord(params) && typeof params.id === "string") {
      this.remoteStreams.delete(params.id);
    }
    wakeStream(state);
  }

  private handleStreamError(params: unknown): void {
    const state = streamStateFor(this.remoteStreams, params);
    if (!state || !isRecord(params)) {
      return;
    }
    state.error = new Error(
      typeof params.message === "string" ? params.message : "remote stream failed",
    );
    state.done = true;
    this.remoteStreams.delete(params.id as string);
    wakeStream(state);
  }

  private releaseCallback(params: unknown): void {
    if (isRecord(params) && typeof params.id === "string") {
      this.localCallbacks.delete(params.id);
    }
  }
}

function resolveApiMethod(
  api: OpenClawPluginApi,
  path: string,
): { call: (...args: unknown[]) => unknown; acceptsSignal: boolean } {
  if (
    !path.startsWith("runtime.") &&
    !path.startsWith("session.") &&
    !path.startsWith("agent.") &&
    !path.startsWith("runContext.")
  ) {
    throw new Error(`unsupported host capability path: ${path}`);
  }
  const segments = path.split(".");
  let owner: unknown = api;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(owner) || isBlockedKey(segment)) {
      throw new Error(`unknown host capability: ${path}`);
    }
    owner = owner[segment];
  }
  const methodName = segments.at(-1);
  if (!methodName || !isRecord(owner) || isBlockedKey(methodName)) {
    throw new Error(`unknown host capability: ${path}`);
  }
  const method = owner[methodName];
  if (typeof method !== "function") {
    throw new Error(`host capability is not callable: ${path}`);
  }
  return { call: method.bind(owner) as (...args: unknown[]) => unknown, acceptsSignal: false };
}

function streamStateFor(
  streams: ReadonlyMap<string, StreamState>,
  params: unknown,
): StreamState | undefined {
  return isRecord(params) && typeof params.id === "string" ? streams.get(params.id) : undefined;
}

function wakeStream(state: StreamState): void {
  for (const wake of state.waiters.splice(0)) {
    wake();
  }
}

function isRpcReference(value: Record<string, unknown>): value is RpcReference {
  return typeof value.$rpc === "string";
}

function isCallbackReference(value: Record<string, unknown>): value is CallbackReference {
  return typeof value.$callback === "string";
}

function isStreamReference(value: Record<string, unknown>): value is StreamReference {
  return typeof value.$stream === "string";
}

function isAbortSignalReference(value: Record<string, unknown>): value is AbortSignalReference {
  return value.$abortSignal === true;
}

function isBytesReference(value: Record<string, unknown>): value is BytesReference {
  return typeof value.$bytes === "string";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

function findAbortSignal(value: unknown, seen = new WeakSet<object>()): AbortSignal | undefined {
  if (isAbortSignal(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const signal = findAbortSignal(entry, seen);
      if (signal) {
        return signal;
      }
    }
    return undefined;
  }
  if (!isRecord(value) || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  for (const entry of Object.values(value)) {
    const signal = findAbortSignal(entry, seen);
    if (signal) {
      return signal;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBlockedKey(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}
