import { spawn } from "node:child_process";

type CurlFetchOptions = {
  proxyUrl?: string;
};

type HeaderParseResult = {
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
};

function findHeaderDelimiter(raw: Buffer, start: number): { index: number; size: number } | null {
  const crlf = raw.indexOf("\r\n\r\n", start, "utf8");
  const lf = raw.indexOf("\n\n", start, "utf8");
  if (crlf === -1 && lf === -1) {
    return null;
  }
  if (crlf === -1) {
    return { index: lf, size: 2 };
  }
  if (lf === -1) {
    return { index: crlf, size: 4 };
  }
  return crlf < lf ? { index: crlf, size: 4 } : { index: lf, size: 2 };
}

function parseCurlHttpResponse(raw: Buffer): HeaderParseResult {
  let cursor = 0;
  let status = 200;
  let statusText = "OK";
  let headers = new Headers();
  let bodyStart = 0;

  while (true) {
    const delim = findHeaderDelimiter(raw, cursor);
    if (!delim) {
      break;
    }
    const block = raw.slice(cursor, delim.index).toString("utf8");
    if (!block.startsWith("HTTP/")) {
      bodyStart = cursor;
      break;
    }

    const lines = block.split(/\r?\n/).filter((line) => line.length > 0);
    const [statusLine, ...headerLines] = lines;
    const m = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine ?? "");
    if (m?.[1]) {
      status = Number.parseInt(m[1], 10);
      statusText = m[2] ?? "";
    }

    headers = new Headers();
    for (const line of headerLines) {
      const idx = line.indexOf(":");
      if (idx <= 0) {
        continue;
      }
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!key || !value) {
        continue;
      }
      headers.append(key, value);
    }

    bodyStart = delim.index + delim.size;
    const nextPrefix = raw.slice(bodyStart, bodyStart + 5).toString("utf8");
    if (!nextPrefix.startsWith("HTTP/")) {
      break;
    }
    cursor = bodyStart;
  }

  return {
    status,
    statusText,
    headers,
    body: raw.slice(bodyStart),
  };
}

export function createTelegramCurlFetch(options: CurlFetchOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const method = request.method || "GET";
    const url = request.url;
    const args = ["--silent", "--show-error", "--include", "--request", method, url];

    if (options.proxyUrl?.trim()) {
      args.push("--proxy", options.proxyUrl.trim());
    }

    const headers = new Headers(request.headers);
    headers.forEach((value, key) => {
      args.push("--header", `${key}: ${value}`);
    });

    const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
    if (hasBody) {
      args.push("--data-binary", "@-");
    }

    return await new Promise<Response>((resolve, reject) => {
      const child = spawn("curl", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const abort = () => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGTERM");
        const err = new Error("Telegram curl fetch aborted");
        err.name = "AbortError";
        reject(err);
      };

      if (request.signal.aborted) {
        abort();
        return;
      }

      request.signal.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

      child.on("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        request.signal.removeEventListener("abort", abort);
        reject(err);
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        request.signal.removeEventListener("abort", abort);
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (code !== 0) {
          reject(new Error(stderr || `curl exited with code ${code ?? "unknown"}`));
          return;
        }
        const parsed = parseCurlHttpResponse(Buffer.concat(stdoutChunks));
        const responseBody = Uint8Array.from(parsed.body).buffer;
        resolve(
          new Response(new Blob([responseBody]), {
            status: parsed.status,
            statusText: parsed.statusText,
            headers: parsed.headers,
          }),
        );
      });

      if (hasBody) {
        request
          .arrayBuffer()
          .then((body) => child.stdin.end(Buffer.from(body)))
          .catch((err) => {
            if (!settled) {
              settled = true;
              request.signal.removeEventListener("abort", abort);
              child.kill("SIGTERM");
              reject(err);
            }
          });
      } else {
        child.stdin.end();
      }
    });
  }) as typeof fetch;
}
