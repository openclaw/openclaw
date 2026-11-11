// kind=ws streams: one tunnel stream carries one WebSocket to the Gateway
// ingress socket. Each message is one frame: opcode byte (1 text, 2 binary,
// 8 close + 2-byte code + reason) then data. Either side closes, then FINs.
import WebSocket, { type RawData } from "ws";
import {
  decodeWsMessage,
  encodeHead,
  encodeWsMessage,
  STREAM_RESET,
  type WsRequestHead,
} from "../../../../packages/openclaw-id-protocol/src/index.js";
import type { IrohSendStream } from "./addon.js";
import { FrameReader, writeFrame } from "./frames.js";
import { responseHeaders } from "./headers.js";
import type { GatewayIngressTarget } from "./http-proxy.js";

// Pause the Gateway socket while this many frames wait for tunnel credit.
const HIGH_WATER = 16;
const LOW_WATER = 4;

/**
 * Proxies one WebSocket. Resolves with 101, the Gateway's refusal status, or
 * "reset" once the tunnel side is finished; never rejects.
 */
export function proxyWs(params: {
  head: WsRequestHead;
  reader: FrameReader;
  send: IrohSendStream;
  headers: Record<string, string | string[]>;
  target: GatewayIngressTarget;
}): Promise<number | "reset"> {
  const { head, reader, send, headers, target } = params;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws+unix:${target.socketPath}:${head.path}`, head.protocols, {
      // SAFETY: ws passes headers to http.request, which also accepts string[] values.
      headers: headers as Record<string, string>,
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
      followRedirects: false,
      maxPayload: 32 * 1024 * 1024,
    });
    const out = new FrameQueue(send, ws);
    let opened = false;

    // The Gateway refused the upgrade: pass its status and headers back, then finish.
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      out.push(
        encodeHead({ status: res.statusCode ?? 502, headers: responseHeaders(res.rawHeaders) }),
      );
      void out.finish().then(() => resolve(res.statusCode ?? 502));
    });
    ws.on("error", () => {
      if (opened) {
        ws.terminate();
        return;
      }
      send.reset(STREAM_RESET.gateway_unreachable).catch(() => {});
      resolve("reset");
    });
    ws.on("open", () => {
      opened = true;
      out.push(encodeHead({ status: 101, protocol: ws.protocol || null }));
      pumpClient(reader, ws, send).catch(() => ws.terminate());
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      // SAFETY: ws delivers Buffer, Buffer[] or ArrayBuffer; the array case is handled first and Buffer.from accepts both others.
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      out.push(encodeWsMessage({ op: isBinary ? "binary" : "text", data: bytes }));
    });
    ws.on("close", (code: number, reason: Buffer) => {
      if (!opened) {
        return;
      }
      out.push(encodeWsMessage({ op: "close", code: code || 1005, reason: reason.toString() }));
      void out.finish().then(() => resolve(101));
    });
  });
}

// Ordered writer toward the tunnel that pauses the Gateway socket when the
// tunnel is slower than the Gateway.
class FrameQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failed = false;

  constructor(
    private readonly send: IrohSendStream,
    private readonly ws: WebSocket,
  ) {}

  push(payload: Uint8Array): void {
    this.pending += 1;
    if (this.pending > HIGH_WATER) {
      this.ws.pause();
    }
    this.tail = this.tail
      .then(() => (this.failed ? undefined : writeFrame(this.send, payload)))
      .catch(() => {
        this.failed = true;
        this.ws.terminate();
      })
      .finally(() => {
        this.pending -= 1;
        if (this.pending <= LOW_WATER) {
          this.ws.resume();
        }
      });
  }

  finish(): Promise<void> {
    return this.tail.then(() => (this.failed ? undefined : this.send.finish())).catch(() => {});
  }
}

// Copies client frames to the Gateway socket until close or end of stream.
async function pumpClient(reader: FrameReader, ws: WebSocket, send: IrohSendStream): Promise<void> {
  for (;;) {
    const frame = await reader.next();
    if (frame === null) {
      ws.terminate();
      return;
    }
    let message;
    try {
      message = decodeWsMessage(frame);
    } catch {
      send.reset(STREAM_RESET.bad_request).catch(() => {});
      ws.terminate();
      return;
    }
    if (message.op === "close") {
      if (isSendableCloseCode(message.code)) {
        ws.close(message.code, message.reason);
      } else {
        ws.close();
      }
      return;
    }
    await sendWs(
      ws,
      message.op === "text" ? Buffer.from(message.data).toString("utf8") : message.data,
    );
  }
}

// Sends one message, waiting for the socket when a lot is already buffered.
function sendWs(ws: WebSocket, data: string | Uint8Array): Promise<void> | undefined {
  if (ws.readyState !== WebSocket.OPEN) {
    return undefined;
  }
  if (ws.bufferedAmount < 1 << 20) {
    ws.send(data);
    return undefined;
  }
  return new Promise((resolve) => {
    ws.send(data, () => resolve());
  });
}

// Close codes an endpoint may send (RFC 6455 section 7.4).
function isSendableCloseCode(code: number | null): code is number {
  return (
    code !== null &&
    ((code >= 1000 && code <= 1003) ||
      (code >= 1007 && code <= 1014) ||
      (code >= 3000 && code <= 4999))
  );
}
