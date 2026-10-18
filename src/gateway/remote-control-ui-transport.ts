import {
  createServer,
  request as httpRequest,
  type ClientRequestArgs,
  type IncomingMessage,
} from "node:http";
import { duplexPair, Writable } from "node:stream";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { WebSocket, createWebSocketStream } from "../../packages/gateway-client/src/websocket.js";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressRequestV1,
  type GatewayControlUiIngressWebSocketRequestV1,
  type GatewayIngressSocketV1,
} from "../plugins/gateway-ingress.types.js";
import { readGatewayPluginReadCookies } from "./control-ui-plugin-auth-cookie.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { MAX_PAYLOAD_BYTES } from "./payload-limits.js";
import type { GatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import type { RemoteControlUiIngressContext } from "./server/client-identity-types.js";

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const WS_OPEN_TIMEOUT_MS = 10_000;

function limitError(message: string): GatewayControlUiIngressError {
  return new GatewayControlUiIngressError("limit-exceeded", message);
}

/** Real Node HTTP and ws parsers over an in-memory socket pair; no listening socket. */
export function createRemoteControlUiTransport({
  context,
  host,
}: {
  context: RemoteControlUiIngressContext;
  host: GatewayControlUiIngressHost;
}) {
  const lifetime = new AbortController();

  function openOperation(inputSignal: AbortSignal) {
    context.assertCurrent();
    const controller = new AbortController();
    const signal = AbortSignal.any([
      inputSignal,
      context.signal,
      host.signal,
      lifetime.signal,
      controller.signal,
    ]);
    signal.throwIfAborted();
    const [client, serverSocket] = duplexPair({ highWaterMark: 64 * 1024 });
    let finished = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const abort = (error: unknown) => controller.abort(error);
    let idleMs = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = idleMs > 0 ? setTimeout(() => serverSocket.emit("timeout"), idleMs) : undefined;
      idleTimer?.unref();
    };
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(idleTimer);
      signal.removeEventListener("abort", destroy);
      client.destroy();
      serverSocket.destroy();
      resolveClosed();
    };
    const destroy = () => {
      const error = toStringifiedError(signal.reason);
      client.destroy(error);
      serverSocket.destroy(error);
      finish();
    };
    signal.addEventListener("abort", destroy, { once: true });
    const check = () => {
      signal.throwIfAborted();
      context.assertCurrent();
    };
    // Gateway WebSocket keepalive expects net.Socket's timeout API on upgrade sockets.
    Object.defineProperties(serverSocket, {
      timeout: { get: () => idleMs },
      setTimeout: {
        value(ms: number, onTimeout?: () => void) {
          idleMs = Math.max(ms, 0);
          if (onTimeout) {
            serverSocket.once("timeout", onTimeout);
          }
          touch();
          return serverSocket;
        },
      },
      setNoDelay: { value: () => serverSocket },
      setKeepAlive: { value: () => serverSocket },
    });
    client.on("error", abort);
    serverSocket.on("error", abort);
    const server = createServer();
    server.emit("connection", serverSocket);
    client.on("data", touch);
    serverSocket.on("data", touch);
    return {
      signal,
      client,
      server,
      abort,
      finish,
      closed,
      check,
      context: Object.freeze({ ...context, signal, assertCurrent: check }),
    };
  }

  async function request(input: GatewayControlUiIngressRequestV1) {
    const op = openOperation(input.signal);
    let receivedResponse: IncomingMessage | undefined;
    // An early HTTP rejection can close the connection before its upload ends.
    const uploadError = (error: unknown) => {
      if (!receivedResponse?.complete || error instanceof GatewayControlUiIngressError) {
        op.abort(error);
      }
    };
    op.server.on("clientError", uploadError);
    let serverResponse: import("node:http").ServerResponse | undefined;
    op.server.on("request", (req, res) => {
      serverResponse = res;
      markGatewayIngressTransport(req, { kind: "remote-forwarded", context: op.context });
      const handler = input.surface === "sandbox" ? host.handleSandboxRequest : host.handleRequest;
      void Promise.resolve()
        .then(() => {
          op.check();
          return handler(req, res);
        })
        .catch(op.abort);
    });
    let req: ReturnType<typeof httpRequest>;
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
      throw error;
    }
    req.on("error", uploadError);
    const responseReady = new Promise<IncomingMessage>((resolve, reject) => {
      req.once("response", (response) => {
        receivedResponse = response;
        resolve(response);
      });
      req.once("error", reject);
    });
    if (input.body) {
      let bytes = 0;
      void input.body
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              op.check();
              bytes += chunk.byteLength;
              if (bytes > MAX_BODY_BYTES) {
                throw limitError("Remote Control UI HTTP request exceeds 100 MiB");
              }
              controller.enqueue(chunk);
            },
          }),
        )
        .pipeTo(Writable.toWeb(req), { signal: op.signal })
        .catch(uploadError);
    } else {
      req.end();
    }
    try {
      const incoming = await responseReady;
      op.check();
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
              const part = await iterator.next();
              op.check();
              if (part.done) {
                controller.close();
                op.finish();
                return;
              }
              const chunk: Buffer = part.value;
              receivedBytes += chunk.byteLength;
              if (receivedBytes > MAX_BODY_BYTES) {
                throw limitError("Remote Control UI HTTP response exceeds 100 MiB");
              }
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
          op.finish();
        });
      }
      return {
        response: new Response(noBody ? null : body, { status, headers }),
        pluginReadCookies: serverResponse ? readGatewayPluginReadCookies(serverResponse) : [],
        closed: op.closed,
      };
    } catch (error) {
      op.abort(error);
      throw toStringifiedError(op.signal.reason);
    }
  }

  async function openWebSocket(input: GatewayControlUiIngressWebSocketRequestV1) {
    const op = openOperation(input.signal);
    op.server.on("clientError", op.abort);
    op.server.on("upgrade", (req, socket, head) => {
      // Accepted Gateway work retains grant authority when the browser disconnects.
      markGatewayIngressTransport(req, { kind: "remote-forwarded", context });
      void Promise.resolve()
        .then(() => {
          op.check();
          return host.handleUpgrade(req, socket, head);
        })
        .catch(op.abort);
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
      throw error;
    }
    const messages = createWebSocketStream(ws, { readableObjectMode: true, highWaterMark: 1 });
    messages.on("error", op.abort);
    const abort = () => messages.destroy(toStringifiedError(op.signal.reason));
    op.signal.addEventListener("abort", abort, { once: true });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => {
        op.signal.removeEventListener("abort", abort);
        op.finish();
        resolve({ code, reason: reason.toString() });
      });
    });
    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", () =>
        reject(
          toStringifiedError(
            op.signal.reason ?? new Error("Remote Control UI WebSocket closed before opening"),
          ),
        ),
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
      throw toStringifiedError(op.signal.reason);
    } finally {
      clearTimeout(openTimer);
    }
    const socket: GatewayIngressSocketV1 = {
      closed,
      async send(message) {
        op.check();
        const value = message.kind === "text" ? message.text : message.bytes;
        const bytes = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
        if (bytes > MAX_PAYLOAD_BYTES) {
          throw limitError("Remote Control UI WebSocket frame exceeds 25 MiB");
        }
        await new Promise<void>((resolve, reject) => {
          ws.send(value, { binary: message.kind === "binary" }, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      },
      messages: {
        async *[Symbol.asyncIterator]() {
          const frames: AsyncIterable<string | Buffer> = messages;
          for await (const frame of frames) {
            op.check();
            yield typeof frame === "string"
              ? ({ kind: "text", text: frame } as const)
              : ({ kind: "binary", bytes: frame } as const);
          }
        },
      },
      close(code = 1000, reason = "") {
        ws.resume();
        ws.close(code, reason);
      },
    };
    return { protocol: ws.protocol || undefined, socket };
  }

  return {
    request,
    openWebSocket,
    close(): Promise<void> {
      lifetime.abort(
        new GatewayControlUiIngressError("closed", "Remote Control UI ingress is closed"),
      );
      return Promise.resolve();
    },
  };
}
