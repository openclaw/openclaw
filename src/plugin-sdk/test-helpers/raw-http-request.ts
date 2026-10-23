// Unlike fetch, retain early rejection responses even when the upload fails mid-body.
import net from "node:net";

const CRLF = Buffer.from("\r\n");

export type RawHttpResult = {
  statusLine: string;
  headers: Record<string, string>;
  body: string;
  closedByServer: boolean;
};

// Chunk sizes count bytes, not decoded characters; scan before UTF-8 decoding.
function decodeChunkedBody(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", offset, "latin1");
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(raw.toString("latin1", offset, lineEnd).trim(), 16);
    if (!Number.isFinite(size) || size <= 0) {
      break;
    }
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

export async function postRawWebhook(params: {
  url: string;
  body: string;
  headers?: Record<string, string>;
  /** How long to keep the socket open before reporting it as retained. */
  idleTimeoutMs?: number;
  /** Incremental upload: let the server reject before the body finishes. */
  chunk?: { bytes: number; intervalMs: number };
  contentLength?: number;
  /** Omit Content-Length to exercise limits on received bytes, not declared length. */
  chunkedEncoding?: boolean;
}): Promise<RawHttpResult> {
  const target = new URL(params.url);
  const port = Number(target.port);
  const payload = Buffer.from(params.body, "utf-8");
  const headerLines = Object.entries(params.headers ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const head =
    `POST ${target.pathname}${target.search} HTTP/1.1\r\n` +
    `Host: ${target.hostname}:${port}\r\n` +
    headerLines +
    (params.chunkedEncoding
      ? `Transfer-Encoding: chunked\r\n\r\n`
      : `Content-Length: ${params.contentLength ?? payload.length}\r\n\r\n`);

  return await new Promise<RawHttpResult>((resolve) => {
    const socket = net.connect(port, target.hostname);
    const received: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (closedByServer: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const raw = Buffer.concat(received);
      const headerEnd = raw.indexOf("\r\n\r\n", 0, "latin1");
      const headBlock =
        headerEnd === -1 ? raw.toString("latin1") : raw.toString("latin1", 0, headerEnd);
      const rawBody = headerEnd === -1 ? Buffer.alloc(0) : raw.subarray(headerEnd + 4);
      const chunked = /transfer-encoding:\s*chunked/i.test(headBlock);
      const [statusLine = "", ...responseHeaders] = headBlock.split("\r\n");
      const headers = Object.fromEntries(
        responseHeaders.map((line) => {
          const separator = line.indexOf(":");
          return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
        }),
      );
      resolve({
        statusLine: statusLine.trim(),
        headers,
        body: (chunked ? decodeChunkedBody(rawBody) : rawBody).toString("utf-8"),
        closedByServer,
      });
    };

    // Frame raw bytes without re-encoding non-ASCII payloads through a string.
    const frameChunk = (data: Buffer) =>
      Buffer.concat([Buffer.from(data.length.toString(16) + "\r\n"), data, CRLF]);
    const writeBody = (data: Buffer) =>
      socket.write(params.chunkedEncoding ? frameChunk(data) : data);

    socket.on("connect", () => {
      socket.write(head);
      const incremental = Boolean(params.chunk);
      const { bytes = payload.length, intervalMs = 0 } = params.chunk ?? {};
      let offset = 0;
      const pump = () => {
        if (settled || socket.destroyed) {
          return;
        }
        const hasBody = offset < payload.length;
        if (!incremental || hasBody) {
          const end = Math.min(offset + bytes, payload.length);
          writeBody(payload.subarray(offset, end));
          offset = end;
        }
        if (incremental && hasBody) {
          setTimeout(pump, intervalMs).unref?.();
        } else if (params.chunkedEncoding) {
          socket.write("0\r\n\r\n");
        }
      };
      pump();
      // Only the idle timeout reports a retained connection.
      timer = setTimeout(() => settle(false), params.idleTimeoutMs ?? 2_000);
      timer.unref?.();
    });
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    // A mid-upload error may follow buffered response bytes; settle only on close.
    socket.on("error", () => {});
    socket.on("close", () => settle(true));
  });
}
