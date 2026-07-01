/**
 * Real behavior proof: Feishu bounded JSON response reads.
 *
 * Both Feishu extension data functions (app-registration at 4 MiB and
 * streaming-card at 1 MiB) were switched from unbounded `response.json()`
 * to shared `readResponseWithLimit` with provider-specific caps.
 *
 * This proof starts real node:http servers streaming oversized JSON without
 * Content-Length, then drives `readResponseWithLimit` against them with both
 * caps.  A negative control confirms unbounded `response.text()` buffers past
 * the 4 MiB cap.
 *
 * Usage: node --import tsx test/_proof_feishu_bounded_json.mts
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Real readResponseWithLimit (same import path as Feishu production code)
// ---------------------------------------------------------------------------
const { readResponseWithLimit } = await import(
  "openclaw/plugin-sdk/response-limit-runtime"
);

const REG_CAP = 4 * 1024 * 1024;  // FEISHU_JSON_RESPONSE_MAX_BYTES
const CARD_CAP = 1 * 1024 * 1024; // FEISHU_STREAMING_CARD_JSON_MAX_BYTES

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
      res.writeHead(200, { "Content-Type": "application/json" });
      let sent = 0;
      const chunk = Buffer.alloc(65536, 0x78);
      function writeChunk() {
        if (sent >= bytes) { res.end("\n]}"); return; }
        const header = sent === 0 ? '{"data":["' : "";
        const payload = header ? Buffer.concat([Buffer.from(header), chunk]) : chunk;
        sent += payload.length;
        if (!res.write(payload)) res.once("drain", writeChunk);
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

function jsonServer(body: unknown): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      res.end(payload);
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
  const OVERSIZED = 6 * 1024 * 1024; // > REG_CAP (4 MiB), well > CARD_CAP (1 MiB)

  // ---- Proof A: App-registration cap (4 MiB) rejects 6 MiB body --------
  {
    const { port, server } = await startServer(OVERSIZED);
    console.log(`[proof] oversized (${OVERSIZED} bytes) server on :${port}, cap=${REG_CAP}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      let thrown = false;
      let msg = "";
      try {
        await readResponseWithLimit(res, REG_CAP, {
          onOverflow: ({ maxBytes }) =>
            new Error(`Feishu JSON response exceeds ${maxBytes} bytes`),
        });
      } catch (err: unknown) {
        thrown = true; msg = String(err);
      }
      check(
        "app-registration cap (4 MiB): oversized body throws bounded error",
        thrown && msg.includes(String(REG_CAP)),
        `threw=${thrown} msg="${msg.slice(0, 80)}"`,
      );
    } finally {
      server.close();
    }
  }

  // ---- Proof B: Streaming-card cap (1 MiB) rejects 6 MiB body ---------
  {
    const { port, server } = await startServer(OVERSIZED);
    console.log(`[proof] oversized (${OVERSIZED} bytes) server on :${port}, cap=${CARD_CAP}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      let thrown = false;
      let msg = "";
      try {
        await readResponseWithLimit(res, CARD_CAP, {
          onOverflow: ({ maxBytes }) =>
            new Error(`Feishu streaming card JSON response exceeds ${maxBytes} bytes`),
        });
      } catch (err: unknown) {
        thrown = true; msg = String(err);
      }
      check(
        "streaming-card cap (1 MiB): oversized body throws bounded error",
        thrown && msg.includes(String(CARD_CAP)),
        `threw=${thrown} msg="${msg.slice(0, 80)}"`,
      );
    } finally {
      server.close();
    }
  }

  // ---- Proof C: Small body parses correctly ----------------------------
  {
    const { port, server } = await jsonServer({ code: 0, msg: "ok", data: { app_id: "cli_9f1" } });
    console.log(`[proof] small JSON server on :${port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await readResponseWithLimit(res, REG_CAP, {
        onOverflow: ({ maxBytes }) =>
          new Error(`Feishu JSON response exceeds ${maxBytes} bytes`),
      });
      const json = JSON.parse(body.toString("utf8"));
      check(
        "small JSON body: parsed correctly",
        json.code === 0 && json.data?.app_id === "cli_9f1",
        `code=${json.code} app_id=${json.data?.app_id}`,
      );
    } finally {
      server.close();
    }
  }

  // ---- Proof D: Negative control — unbounded buffers past cap ----------
  {
    const { port, server } = await startServer(OVERSIZED);
    console.log(`[proof] negative control server on :${port}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const text = await res.text();
      check(
        "negative control: unbounded read buffers past 4 MiB cap",
        text.length > REG_CAP,
        `buffered=${text.length} (> ${REG_CAP})`,
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
