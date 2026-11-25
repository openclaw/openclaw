// kind=http streams: one tunnel stream carries one HTTP request to the Gateway
// ingress socket. Bodies stream frame by frame with backpressure both ways;
// compressed responses (gzip, br) pass through as bytes, never re-encoded.
import { once } from "node:events";
import http from "node:http";
import {
  encodeHead,
  HTTP_STREAM_IDLE_TIMEOUT_MS,
  MAX_HTTP_DATA_FRAME_BYTES,
  STREAM_RESET,
  TunnelProtocolError,
  type HttpRequestHead,
} from "../../../../packages/openclaw-id-protocol/src/index.js";
import type { IrohSendStream } from "./addon.js";
import { FrameReader, writeDataFrames, writeFrame } from "./frames.js";
import { responseHeaders } from "./headers.js";

/** Where the child reaches the Gateway. */
export type GatewayIngressTarget = { socketPath: string };

/**
 * Proxies one request. Resolves with the response status, or "reset" when the
 * stream was reset; never rejects.
 */
export function proxyHttp(params: {
  head: HttpRequestHead;
  reader: FrameReader;
  send: IrohSendStream;
  headers: Record<string, string | string[]>;
  target: GatewayIngressTarget;
  idleMs?: number;
}): Promise<number | "reset"> {
  const { head, reader, send, headers, target } = params;
  return new Promise((resolve) => {
    let done = false;
    // Ends the exchange with a stream reset; later calls are ignored.
    const fail = (code: number) => {
      if (done) {
        return;
      }
      done = true;
      req.destroy();
      send.reset(code).catch(() => {});
      resolve("reset");
    };
    const req = http.request({
      socketPath: target.socketPath,
      method: head.method,
      path: head.path,
      // Node leaves some method bodies unframed unless transfer encoding is explicit.
      headers: { ...headers, "transfer-encoding": "chunked" },
    });
    req.setTimeout(params.idleMs ?? HTTP_STREAM_IDLE_TIMEOUT_MS, () =>
      fail(STREAM_RESET.gateway_unreachable),
    );
    req.on("error", () => fail(STREAM_RESET.gateway_unreachable));
    req.on("response", (res) => {
      void (async () => {
        try {
          await writeFrame(
            send,
            encodeHead({ status: res.statusCode ?? 502, headers: responseHeaders(res.rawHeaders) }),
          );
          for await (const chunk of res) {
            // SAFETY: IncomingMessage without setEncoding yields Buffer chunks.
            await writeDataFrames(send, chunk as Buffer);
          }
          await send.finish();
          done = true;
          resolve(res.statusCode ?? 502);
        } catch {
          fail(STREAM_RESET.gateway_unreachable);
        }
      })();
    });
    pumpBody(reader, req).catch((error: unknown) =>
      fail(
        error instanceof TunnelProtocolError
          ? STREAM_RESET.bad_request
          : STREAM_RESET.gateway_unreachable,
      ),
    );
  });
}

// Copies DATA frames into the upstream request until the client finishes.
async function pumpBody(reader: FrameReader, req: http.ClientRequest): Promise<void> {
  for (;;) {
    const frame = await reader.next(MAX_HTTP_DATA_FRAME_BYTES);
    if (frame === null) {
      req.end();
      return;
    }
    if (!req.write(frame)) {
      await once(req, "drain");
    }
  }
}
