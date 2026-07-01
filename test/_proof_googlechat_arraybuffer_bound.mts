/**
 * Real behavior proof: Google Chat bounded arrayBuffer response reads.
 *
 * The googlechat `fetchBuffer` helper was used without a default byte cap,
 * falling back to unbounded `Buffer.from(await res.arrayBuffer())`.
 * This proof starts a real node:http server streaming oversized binary data
 * and drives `readResponseWithLimit` with the 16 MiB cap against it.
 * A negative control confirms unbounded `response.arrayBuffer()` buffers past
 * the cap.
 *
 * Usage: node --import tsx test/_proof_googlechat_arraybuffer_bound.mts
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Real readResponseWithLimit (same import as Google Chat production code)
// ---------------------------------------------------------------------------
const { readResponseWithLimit } = await import(
  "openclaw/plugin-sdk/response-limit-runtime"
);

const CAP = 16 * 1024 * 1024; // GOOGLE_CHAT_MEDIA_RESPONSE_MAX_BYTES
const OVERSIZED = 18 * 1024 * 1024; // 18 MiB > 16 MiB cap

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`); }
  else { fail++; console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
}

function startServer(bytes: number): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      let sent = 0;
      const chunk = Buffer.alloc(65536, 0x42);
      function writeChunk() {
        if (sent >= bytes) { res.end(); return; }
        sent += chunk.length;
        if (!res.write(chunk)) res.once("drain", writeChunk);
        else setImmediate(writeChunk);
      }
      writeChunk();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, server });
    });
  });
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------
async function main() {
  // ---- Proof A: 18 MiB body rejected at 16 MiB cap --------------------
  {
    const { port, server } = await startServer(OVERSIZED);
    console.log(`[proof] oversized (${OVERSIZED} bytes) server on :${port}, cap=${CAP}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      let thrown = false;
      let msg = "";
      try {
        await readResponseWithLimit(res, CAP, {
          onOverflow: ({ maxBytes }) =>
            new Error(`Google Chat media exceeds max bytes (${maxBytes})`),
        });
      } catch (err: unknown) {
        thrown = true; msg = String(err);
      }
      check(
        "oversized body: bounded read throws at 16 MiB cap",
        thrown && msg.includes(String(CAP)),
        `threw=${thrown} msg="${msg.slice(0, 80)}"`,
      );
    } finally {
      server.close();
    }
  }

  // ---- Proof B: Small binary body parses correctly --------------------
  {
    const SMALL = 1024;
    const { port, server } = await startServer(SMALL);
    console.log(`[proof] small (${SMALL} bytes) server on :${port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const buffer = await readResponseWithLimit(res, CAP, {
        onOverflow: ({ maxBytes }) =>
          new Error(`Google Chat media exceeds max bytes (${maxBytes})`),
      });
      check(
        "small binary body: parsed correctly",
        buffer.length === SMALL,
        `buffer.length=${buffer.length} expected=${SMALL}`,
      );
    } finally {
      server.close();
    }
  }

  // ---- Proof C: Negative control — unbounded arrayBuffer past cap -----
  {
    const { port, server } = await startServer(OVERSIZED);
    console.log(`[proof] negative control server on :${port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const arrayBuffer = await res.arrayBuffer();
      check(
        "negative control: unbounded arrayBuffer buffers past 16 MiB cap",
        arrayBuffer.byteLength > CAP,
        `buffered=${arrayBuffer.byteLength} (> ${CAP})`,
      );
    } finally {
      server.close();
    }
  }

  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[proof] harness failed:", err);
  process.exit(1);
});
