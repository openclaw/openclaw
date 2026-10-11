import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type ClientRequestArgs,
  type IncomingMessage,
} from "node:http";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { WebSocket, type RawData } from "../../packages/gateway-client/src/websocket.js";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressRequestV1,
  type GatewayControlUiIngressWebSocketRequestV1,
  type GatewayIngressMessage,
  type GatewayIngressSocketV1,
} from "../plugins/gateway-ingress.types.js";
import { readGatewayPluginReadCookies } from "./control-ui-plugin-auth-cookie.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import type { RemoteControlUiIngressContext } from "./remote-control-ui-context.js";
import { createRemoteControlUiResponseAccounting } from "./remote-control-ui-http-response.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { bindRemoteControlUiSocketBuffer } from "./remote-control-ui-socket-buffer.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const MAX_QUEUED_MESSAGES = 64;
const HTTP_PROGRESS_TIMEOUT_MS = 30_000;
const HTTP_OVERALL_TIMEOUT_MS = 5 * 60_000;
const WS_OPEN_TIMEOUT_MS = 10_000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function limitError(message: string): GatewayControlUiIngressError {
  return new GatewayControlUiIngressError("limit-exceeded", message);
}

/** Real Node HTTP and ws parsers over bounded in-memory streams; no listening socket. */
export function createRemoteControlUiTransport(params: {
  context: RemoteControlUiIngressContext;
  host: GatewayControlUiIngressHost;
  reserveBytes: (bytes: number) => () => void;
}) {
  const { context, host, reserveBytes } = params;
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const operations = new Set<() => void>();
  const releaseQueues = new Set<() => void>();
  let closing: Promise<void> | undefined;

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }

  function assertCurrent(): void {
    lifetime.signal.throwIfAborted();
    host.signal.throwIfAborted();
    context.signal.throwIfAborted();
    context.assertCurrent();
  }

  function openOperation(inputSignal: AbortSignal, timeoutMs?: number) {
    assertCurrent();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      inputSignal,
      context.signal,
      host.signal,
      lifetime.signal,
      controller.signal,
    ]);
    signal.throwIfAborted();
    const streams: Duplex[] = [];
    const streamClosed: Promise<void>[] = [];
    let finished = false;
    let resolveDone!: () => void;
    const done = track(
      new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
    );
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => abort(new Error("Remote Control UI request timed out")), timeoutMs);
    timeout?.unref();
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", destroy);
      operations.delete(destroy);
      for (const stream of streams) {
        stream.destroy();
      }
      void Promise.all(streamClosed).then(resolveDone);
    };
    const destroy = () => {
      for (const stream of streams) {
        stream.destroy(asError(signal.reason ?? new Error("Remote Control UI transport closed")));
      }
      finish();
    };
    const abort = (error: unknown) => {
      controller.abort(error);
    };
    operations.add(destroy);
    signal.addEventListener("abort", destroy, { once: true });
    const check = () => {
      signal.throwIfAborted();
      assertCurrent();
    };
    const operationContext = Object.freeze({ ...context, signal, assertCurrent: check });

    const left = new PassThrough({ highWaterMark: 64 * 1024 });
    const right = new PassThrough({ highWaterMark: 64 * 1024 });
    const makeSide = (readable: PassThrough, destination: PassThrough) =>
      Duplex.fromWeb({
        readable: Readable.toWeb(readable, {
          strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
        }),
        writable: Writable.toWeb(
          new Writable({
            highWaterMark: 64 * 1024,
            write(chunk: Buffer, _encoding, callback) {
              try {
                check();
                destination.write(chunk, (error) => {
                  try {
                    check();
                    callback(error);
                  } catch (failure) {
                    callback(asError(failure));
                  }
                });
              } catch (error) {
                callback(asError(error));
              }
            },
            final(callback) {
              destination.end(callback);
            },
            destroy(error, callback) {
              // A finished writer can still have unread peer bytes; allow their normal drain.
              if (error || !this.writableFinished) {
                destination.destroy(error ?? undefined);
              }
              callback(error);
            },
          }),
        ),
      });
    const client = makeSide(left, right);
    const serverSocket = makeSide(right, left);
    const releaseClientBytes = bindRemoteControlUiSocketBuffer({
      writer: client,
      reader: serverSocket,
      assertCurrent: check,
      reserveBytes,
      abort,
    });
    const releaseServerBytes = bindRemoteControlUiSocketBuffer({
      writer: serverSocket,
      reader: client,
      assertCurrent: check,
      reserveBytes,
      abort,
    });
    void done.then(() => {
      releaseClientBytes();
      releaseServerBytes();
    });
    streams.push(client, serverSocket);
    for (const stream of streams) {
      streamClosed.push(
        new Promise<void>((resolve) => {
          stream.once("close", resolve);
        }),
      );
    }
    // Both directions belong to one operation, including parser and writer failures.
    for (const stream of [left, right, ...streams]) {
      stream.on("error", abort);
    }
    const responseBytes = createRemoteControlUiResponseAccounting({
      assertCurrent: check,
      reserveBytes,
      abort,
    });
    void done.then(() => responseBytes.dispose());
    const server = createServer({ ServerResponse: responseBytes.Response });
    server.on("clientError", abort);
    server.emit("connection", serverSocket);
    return {
      signal,
      context: operationContext,
      client,
      server,
      abort,
      finish,
      done,
      check,
      responseBytes,
    };
  }

  async function request(input: GatewayControlUiIngressRequestV1) {
    const op = openOperation(input.signal, HTTP_OVERALL_TIMEOUT_MS);
    let serverResponse: import("node:http").ServerResponse | undefined;
    let handlerWork: Promise<unknown> = Promise.resolve();
    let progressTimer: ReturnType<typeof setTimeout>;
    const progress = () => {
      clearTimeout(progressTimer);
      progressTimer = setTimeout(
        () => op.abort(new Error("Remote Control UI HTTP stream made no progress")),
        HTTP_PROGRESS_TIMEOUT_MS,
      );
      progressTimer.unref();
    };
    progress();
    void op.done.then(() => clearTimeout(progressTimer));
    op.server.on("request", (req, res) => {
      serverResponse = res;
      markGatewayIngressTransport(req, { kind: "remote-forwarded", context: op.context });
      const handler = input.surface === "sandbox" ? host.handleSandboxRequest : host.handleRequest;
      const work = Promise.resolve()
        .then(() => {
          op.check();
          return handler(req, res);
        })
        .then(() => op.check());
      handlerWork = work;
      void track(work).catch(op.abort);
    });
    let req: ClientRequest;
    try {
      req = httpRequest({
        host: "ingress.invalid",
        method: input.method,
        path: input.pathAndQuery,
        headers: input.headers.flatMap(([name, value]) => [name, value]),
        createConnection: () => op.client,
        signal: op.signal,
      });
    } catch (error) {
      op.abort(error);
      await op.done;
      throw error;
    }
    req.on("error", op.abort);
    const responseReady = new Promise<IncomingMessage>((resolve, reject) => {
      req.once("response", resolve);
      req.once("error", reject);
    });
    let stopUpload = () => {};
    const upload = async () => {
      const reader = input.body?.getReader();
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        cancellation ??= reader?.cancel(op.signal.reason).catch(() => undefined);
      };
      stopUpload = cancel;
      op.signal.addEventListener("abort", cancel, { once: true });
      try {
        let bytes = 0;
        if (reader) {
          while (true) {
            const part = await reader.read();
            op.check();
            if (part.done) {
              break;
            }
            bytes += part.value.byteLength;
            if (bytes > MAX_BODY_BYTES) {
              throw limitError("Remote Control UI HTTP request exceeds 100 MiB");
            }
            const releaseChunk = reserveBytes(part.value.byteLength);
            try {
              for (let offset = 0; offset < part.value.byteLength; offset += 64 * 1024) {
                op.check();
                await new Promise<void>((resolve, reject) => {
                  req.write(part.value.subarray(offset, offset + 64 * 1024), (error) =>
                    error ? reject(error) : resolve(),
                  );
                });
                op.check();
                progress();
              }
            } finally {
              releaseChunk();
            }
          }
        }
        op.check();
        req.end();
      } finally {
        op.signal.removeEventListener("abort", cancel);
        stopUpload = () => {};
        cancel();
        await cancellation;
        reader?.releaseLock();
      }
    };
    const uploadWork = track(upload());
    void uploadWork.catch(op.abort);
    try {
      const incoming = await responseReady;
      op.check();
      progress();
      incoming.on("error", op.abort);
      const headers = new Headers();
      for (const [name, values] of Object.entries(incoming.headersDistinct)) {
        for (const value of values ?? []) {
          headers.append(name, value);
        }
      }
      let receivedBytes = 0;
      const iterator = incoming[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              op.check();
              const part = await iterator.next();
              op.check();
              progress();
              if (part.done) {
                controller.close();
                stopUpload();
                op.finish();
                return;
              }
              const chunk: Buffer = part.value;
              receivedBytes += chunk.byteLength;
              if (receivedBytes > MAX_BODY_BYTES) {
                throw limitError("Remote Control UI HTTP response exceeds 100 MiB");
              }
              op.check();
              op.responseBytes.consume(chunk.byteLength);
              controller.enqueue(chunk);
            } catch (error) {
              const failure = op.signal.aborted ? op.signal.reason : error;
              controller.error(failure);
              op.abort(failure);
            }
          },
          cancel(reason) {
            op.abort(reason ?? new Error("Remote Control UI response cancelled"));
          },
        },
        { highWaterMark: 0 },
      );
      const status = incoming.statusCode ?? 500;
      const noBody = input.method === "HEAD" || status === 204 || status === 205 || status === 304;
      if (noBody) {
        incoming.resume();
        incoming.once("end", () => {
          stopUpload();
          op.finish();
        });
      }
      op.check();
      return {
        response: new Response(noBody ? null : body, { status, headers }),
        pluginReadCookies: serverResponse ? readGatewayPluginReadCookies(serverResponse) : [],
        completion: Promise.allSettled([op.done, handlerWork, uploadWork]).then(() => undefined),
      };
    } catch (error) {
      op.abort(error);
      const failure = asError(op.signal.reason);
      await Promise.allSettled([op.done, handlerWork, uploadWork]);
      throw failure;
    }
  }

  async function openWebSocket(input: GatewayControlUiIngressWebSocketRequestV1) {
    const op = openOperation(input.signal);
    let upgradeWork: Promise<unknown> = Promise.resolve();
    op.server.on("upgrade", (req, socket, head) => {
      // Accepted Gateway work belongs to the grant, independently of browser transport loss.
      markGatewayIngressTransport(req, { kind: "remote-forwarded", context });
      const work = Promise.resolve()
        .then(() => {
          op.check();
          return host.handleUpgrade(req, socket, head);
        })
        .then(() => op.check());
      upgradeWork = work;
      void track(work).catch(op.abort);
    });
    const options: ClientRequestArgs & { maxPayload: number; perMessageDeflate: false } = {
      createConnection: () => op.client,
      headers: { origin: input.origin },
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(
        `ws://ingress.invalid${input.pathAndQuery}`,
        [...input.protocols],
        options,
      );
    } catch (error) {
      op.abort(error);
      await Promise.allSettled([op.done, upgradeWork]);
      throw error;
    }
    let failure: Error | undefined;
    let ended = false;
    let acceptingMessages = true;
    let notify: (() => void) | undefined;
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    const queue: { message: GatewayIngressMessage; release: () => void }[] = [];
    const discard = () => {
      acceptingMessages = false;
      for (const entry of queue.splice(0)) {
        entry.release();
      }
      releaseQueues.delete(discard);
      resolveDrained();
    };
    releaseQueues.add(discard);
    const abort = () => {
      failure ??= asError(op.signal.reason);
      discard();
      ws.terminate();
      notify?.();
    };
    op.signal.addEventListener("abort", abort, { once: true });
    ws.on("error", (error) => {
      failure = error;
      op.abort(error);
    });
    const closed = track(
      new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => {
          ended = true;
          if (queue.length === 0) {
            discard();
          }
          op.signal.removeEventListener("abort", abort);
          notify?.();
          op.finish();
          resolve({ code, reason: reason.toString() });
        });
      }),
    );
    ws.on("message", (data: RawData, isBinary) => {
      if (!acceptingMessages) {
        return;
      }
      let release: (() => void) | undefined;
      try {
        op.check();
        if (queue.length >= MAX_QUEUED_MESSAGES) {
          throw limitError("Remote Control UI WebSocket receive queue is full");
        }
        const bytes = Array.isArray(data)
          ? data.reduce((total, item) => total + item.byteLength, 0)
          : data.byteLength;
        if (bytes > MAX_PAYLOAD_BYTES) {
          throw limitError("Remote Control UI WebSocket frame exceeds 25 MiB");
        }
        release = reserveBytes(bytes);
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        queue.push({
          message: isBinary
            ? { kind: "binary", bytes: buffer }
            : { kind: "text", text: buffer.toString() },
          release,
        });
        notify?.();
      } catch (error) {
        release?.();
        op.abort(error);
      }
    });
    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", () =>
        reject(failure ?? new Error("Remote Control UI WebSocket closed before opening")),
      );
    });
    const openTimer = setTimeout(
      () => op.abort(new Error("Remote Control UI WebSocket opening timed out")),
      WS_OPEN_TIMEOUT_MS,
    );
    openTimer.unref();
    try {
      await opened;
      op.check();
    } catch (error) {
      op.abort(error);
      const openingError = asError(op.signal.reason);
      await Promise.allSettled([op.done, closed, upgradeWork]);
      throw openingError;
    } finally {
      clearTimeout(openTimer);
    }
    let reading = false;
    let activeSends = 0;
    const completion = track(Promise.all([closed, drained]).then(() => undefined));
    const socket: GatewayIngressSocketV1 = {
      closed,
      async send(message) {
        op.check();
        const value = message.kind === "text" ? message.text : message.bytes;
        const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
        if (bytes > MAX_PAYLOAD_BYTES) {
          throw limitError("Remote Control UI WebSocket frame exceeds 25 MiB");
        }
        if (activeSends >= MAX_QUEUED_MESSAGES) {
          throw limitError("Remote Control UI WebSocket send queue is full");
        }
        activeSends += 1;
        try {
          await track(
            new Promise<void>((resolve, reject) => {
              ws.send(value, { binary: message.kind === "binary" }, (error) =>
                error ? reject(error) : resolve(),
              );
            }),
          );
          op.check();
        } catch (error) {
          throw asError(op.signal.aborted ? op.signal.reason : error);
        } finally {
          activeSends -= 1;
        }
      },
      messages: {
        async *[Symbol.asyncIterator]() {
          if (reading) {
            throw new Error("Remote Control UI WebSocket messages already have a reader");
          }
          reading = true;
          try {
            while (true) {
              op.check();
              if (failure) {
                throw failure;
              }
              const entry = queue.shift();
              if (entry) {
                entry.release();
                if (ended && queue.length === 0) {
                  discard();
                }
                op.check();
                yield entry.message;
                continue;
              }
              if (ended) {
                releaseQueues.delete(discard);
                return;
              }
              await new Promise<void>((resolve) => {
                notify = resolve;
              });
              notify = undefined;
              op.check();
            }
          } finally {
            discard();
            if (!ended) {
              ws.terminate();
            }
          }
        },
      },
      close(code = 1000, reason = "") {
        ws.close(code, reason);
        discard();
      },
    };
    return { protocol: ws.protocol || undefined, socket, completion };
  }

  return {
    request,
    openWebSocket,
    close(): Promise<void> {
      closing ??= (async () => {
        lifetime.abort(
          new GatewayControlUiIngressError("closed", "Remote Control UI ingress is closed"),
        );
        for (const abort of operations) {
          abort();
        }
        for (const release of releaseQueues) {
          release();
        }
        while (pending.size > 0) {
          await Promise.allSettled(pending);
        }
      })();
      return closing;
    },
  };
}
