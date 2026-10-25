import { once } from "node:events";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { ClientOptions, RawData, WebSocket } from "ws";
import {
  buildCloudflareAccessHeaders,
  type CloudflareAccessCredentials,
} from "../../packages/gateway-client/src/cloudflare-access.js";
import { applyGatewayWebSocketTlsPin } from "../../packages/gateway-client/src/websocket-transport.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createLoopbackConnectOptions } from "../infra/loopback-connect.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";

const loadWebSocketConstructor = createLazyRuntimeNamedExport(
  () => import("../../packages/gateway-client/src/websocket.js"),
  "WebSocket",
);

const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PAUSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_CHECK_MS = 25;
// An empty target close has nothing left to deliver. Bound that handshake so
// a silent gateway cannot hold the command open.
const STREAM_CLOSE_ACK_MS = 5_000;
// A peer that stops reading leaves the payload queued in this process.
// This bounds that wait before close(). After close(), ws owns the
// handshake and destroys the socket on its own 30 second timer.
const STREAM_CLOSE_FLUSH_MS = 30_000;
const streamLog = createSubsystemLogger("node-host/stream");

type NodeStreamCloseTrigger =
  | "owner-abort"
  | "target-close"
  | "target-error"
  | "websocket-close"
  | "websocket-error"
  | "send-error"
  | "invalid-frame"
  | "splice-unavailable"
  | "startup-error";

type NodeStreamDiagnostics = { trigger?: NodeStreamCloseTrigger };

/** Pairs an enrolled Gateway attach socket with a node-owned loopback connection. */
export async function runNodeStreamTransport(params: {
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  attachPath: string;
  expectedAttachPath: string;
  target: { stream: Duplex } | { port: number };
  metadata: Record<string, string | boolean>;
  streamName: string;
  signal: AbortSignal;
  emitStatus?: (status: string) => Promise<void>;
}): Promise<void> {
  const socket = "stream" in params.target ? params.target.stream : new net.Socket();
  // Loopback peers may send immediately; retain their first bytes until metadata is accepted.
  socket.pause();
  const diagnostics: NodeStreamDiagnostics = {};
  let ws: WebSocket | undefined;
  const onAbort = () => {
    diagnostics.trigger ??= "owner-abort";
    socket.destroy();
    ws?.terminate();
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  if (params.signal.aborted) {
    onAbort();
  }
  try {
    if (params.signal.aborted) {
      return;
    }
    const NpmWebSocket = await racePromiseWithAbortSignal(
      loadWebSocketConstructor(),
      params.signal,
    );
    if (params.signal.aborted) {
      return;
    }
    const gateway = new URL(params.gatewayUrl);
    const url = new URL(params.attachPath, gateway);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(`${params.streamName} stream gateway URL must use WebSocket transport`);
    }
    if (url.origin !== gateway.origin || url.pathname !== params.expectedAttachPath) {
      throw new Error(`${params.streamName} stream attachPath must stay on the connected gateway`);
    }
    // Auxiliary streams share the enrolled node's reverse-proxy mount point.
    url.pathname = `${gateway.pathname.replace(/\/$/u, "")}${url.pathname}`;
    const attachUrl = url.toString();
    const tlsFingerprint = params.gatewayTlsFingerprint;
    const cloudflareAccess = params.gatewayCloudflareAccess;
    const options: ClientOptions = {
      maxPayload: MAX_PAYLOAD_BYTES,
      ...(cloudflareAccess ? { headers: buildCloudflareAccessHeaders(cloudflareAccess) } : {}),
    };
    if (tlsFingerprint?.trim()) {
      applyGatewayWebSocketTlsPin(options, tlsFingerprint);
    }
    ws = new NpmWebSocket(attachUrl, options);
    ws.once("error", () => {
      diagnostics.trigger ??= "websocket-error";
    });
    ws.once("close", (closeCode) => {
      // Owner teardown can also produce 1006; retain its earlier trigger separately.
      streamLog.info("node stream closed", {
        streamKind: params.streamName,
        trigger: diagnostics.trigger ?? "websocket-close",
        closeCode,
      });
    });
    await racePromiseWithAbortSignal(once(ws, "open"), params.signal);
    if (params.signal.aborted) {
      return;
    }
    if ("port" in params.target && socket instanceof net.Socket) {
      // Portals attach first so a refused target closes the claimed ticket.
      socket.connect(createLoopbackConnectOptions(params.target.port));
      await racePromiseWithAbortSignal(once(socket, "connect"), params.signal);
    }
    if (params.signal.aborted) {
      return;
    }
    if (socket.destroyed) {
      throw socket.errored ?? new Error(`${params.streamName} stream target closed before attach`);
    }
    ws.pause();
    const streamWs = ws;
    const streamName = params.streamName;
    let resumeTimer: ReturnType<typeof setInterval> | undefined;
    let cancelCloseAck: (() => void) | undefined;
    let settled = false;
    let forwardedBytes = 0;
    let finish!: (trigger: NodeStreamCloseTrigger, error?: Error) => void;
    const resumeWebSocket = () => streamWs.resume();
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (socket.destroyed || socket.writableEnded) {
        return;
      }
      if (!isBinary) {
        finish("invalid-frame", new Error(`gateway sent non-binary ${streamName} stream data`));
        return;
      }
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (!socket.write(buffer)) {
        streamWs.pause();
      }
    };
    const stopInbound = () => {
      streamWs.off("message", onMessage);
      socket.off("drain", resumeWebSocket);
      // A closed target cannot emit drain, but WebSocket close frames still need reads.
      streamWs.resume();
    };
    const done = new Promise<void>((resolve, reject) => {
      finish = (trigger, error) => {
        if (settled) {
          return;
        }
        diagnostics.trigger ??= trigger;
        settled = true;
        clearInterval(resumeTimer);
        cancelCloseAck?.();
        cancelCloseAck = undefined;
        stopInbound();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      streamWs.on("message", onMessage);
      socket.on("drain", resumeWebSocket);
      socket.on("data", (chunk) => {
        if (streamWs.readyState !== WEBSOCKET_OPEN) {
          return;
        }
        forwardedBytes += chunk.length;
        streamWs.send(chunk, { binary: true }, (error) => error && finish("send-error", error));
        if (streamWs.bufferedAmount <= PAUSE_BUFFERED_BYTES || resumeTimer) {
          return;
        }
        socket.pause();
        resumeTimer = setInterval(() => {
          if (streamWs.bufferedAmount <= PAUSE_BUFFERED_BYTES) {
            clearInterval(resumeTimer);
            resumeTimer = undefined;
            socket.resume();
          }
        }, RESUME_CHECK_MS);
        resumeTimer.unref?.();
      });
      streamWs.once("close", () => finish("websocket-close"));
      streamWs.once("error", (error) => finish("websocket-error", error));
      socket.once("close", () => {
        diagnostics.trigger ??= "target-close";
        stopInbound();
        if (socket.readableEnded && streamWs.readyState === WEBSOCKET_OPEN) {
          const retireUnacknowledged = () => {
            cancelCloseAck = undefined;
            finish("websocket-close");
            if (
              streamWs.readyState === WEBSOCKET_OPEN ||
              streamWs.readyState === WEBSOCKET_CLOSING
            ) {
              streamWs.terminate();
            }
          };
          if (forwardedBytes === 0) {
            streamWs.close();
            const timer = setTimeout(retireUnacknowledged, STREAM_CLOSE_ACK_MS);
            cancelCloseAck = () => clearTimeout(timer);
            return;
          }
          // bufferedAmount === 0 only means the kernel accepted the bytes.
          // Finish on the gateway close, not on a timer, or the receive stream
          // is destroyed while those bytes are still downstream.
          let observedAmount = streamWs.bufferedAmount;
          let progressAt = Date.now();
          const closeAfterDrain = () => {
            if (settled || streamWs.readyState !== WEBSOCKET_OPEN) {
              return;
            }
            cancelCloseAck?.();
            cancelCloseAck = undefined;
            const amount = streamWs.bufferedAmount;
            const now = Date.now();
            if (amount < observedAmount) {
              observedAmount = amount;
              progressAt = now;
            }
            if (amount > 0) {
              if (now - progressAt < STREAM_CLOSE_FLUSH_MS) {
                const timer = setTimeout(closeAfterDrain, RESUME_CHECK_MS);
                cancelCloseAck = () => clearTimeout(timer);
                return;
              }
              retireUnacknowledged();
              return;
            }
            streamWs.close();
          };
          closeAfterDrain();
        } else {
          finish("target-close");
        }
      });
      socket.once("error", (error) => finish("target-error", error));
    });
    void done.catch(() => undefined);
    const splice = {
      done,
      start() {
        if (socket.destroyed || streamWs.readyState !== WEBSOCKET_OPEN) {
          finish("splice-unavailable");
          return;
        }
        socket.resume();
        streamWs.resume();
      },
    };
    const attachMetadata = params.metadata;
    const attachMetadataBuffer = Buffer.from(JSON.stringify(attachMetadata), "utf8");
    try {
      await new Promise<void>((resolve, reject) => {
        streamWs.send(attachMetadataBuffer, { binary: true }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } finally {
      attachMetadataBuffer.fill(0);
    }
    void params.emitStatus?.(`${params.streamName} stream attached\n`).catch(() => undefined);
    splice.start();
    await splice.done;
  } catch (error) {
    diagnostics.trigger ??= "startup-error";
    if (!params.signal.aborted) {
      throw error;
    }
  } finally {
    params.signal.removeEventListener("abort", onAbort);
    socket.destroy();
    if (
      ws &&
      (ws.readyState === WEBSOCKET_CONNECTING ||
        ws.readyState === WEBSOCKET_OPEN ||
        ws.readyState === WEBSOCKET_CLOSING)
    ) {
      const closing = ws;
      // A protocol error may already have called close(), which starts the
      // library handshake timer. Otherwise start that same close.
      if (closing.readyState !== WEBSOCKET_CLOSING) {
        closing.close();
      }
    }
  }
}
