/**
 * Real behavior proof — bounded JSON response reads (1 MiB cap).
 *
 * Starts a real node:http server that streams Content-Length-less JSON bodies,
 * then drives the real readResponseWithLimit against it over a real TCP socket.
 * Includes server-side bytes-on-wire measurement and a negative control.
 *
 * Usage: node --import tsx test/_proof_bounded_json.mts
 */
import http from "node:http";
import { Buffer } from "node:buffer";

const { readResponseWithLimit } = await import(
  "../packages/media-core/src/read-response-with-limit.js"
);

const CAP = 1 * 1024 * 1024; // 1 MiB
const WOULD_STREAM = 64 * 1024 * 1024; // ~64 MiB

let overflowBytesSent = 0;
let overflowSocketAborted = false;

const overflowServer = await new Promise<http.Server>((resolve) => {
  const s = http.createServer((_req, res) => {
    overflowBytesSent = 0;
    overflowSocketAborted = false;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"status":"ok","data":[');
    function writeChunk() {
      if (overflowBytesSent >= WOULD_STREAM) { res.end("]}"); return; }
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      res.write(chunk);
      overflowBytesSent += chunk.length;
      setImmediate(writeChunk);
    }
    writeChunk();
  });
  s.on("connection", (sock) => {
    sock.on("close", () => {
      if (overflowBytesSent > 0 && overflowBytesSent < WOULD_STREAM - 65536)
        overflowSocketAborted = true;
    });
  });
  s.listen(0, "127.0.0.1", () => resolve(s));
});
const overflowAddr = overflowServer.address();
const overflowPort = typeof overflowAddr === "object" && overflowAddr ? overflowAddr.port : 0;

const smallServer = await new Promise<http.Server>((resolve) => {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "30" });
    res.end(JSON.stringify({ status: "ok", id: "batch-1" }));
  });
  s.listen(0, "127.0.0.1", () => resolve(s));
});
const smallAddr = smallServer.address();
const smallPort = typeof smallAddr === "object" && smallAddr ? smallAddr.port : 0;

console.log(`[proof] real server on :${overflowPort}, cap=${CAP} bytes, would-stream≈${WOULD_STREAM} bytes`);
console.log(`[proof] small server on :${smallPort}`);
console.log("");

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label} :: ${detail}`);
  if (cond) pass++; else fail++;
}

try {
  // A: Oversized
  const resA = await fetch(`http://127.0.0.1:${overflowPort}/`);
  let threw = false, msg = "";
  try {
    await readResponseWithLimit(resA, CAP, {
      onOverflow: ({ maxBytes }) => new Error(`JSON response exceeds ${maxBytes} bytes`),
    });
  } catch (e: unknown) { threw = true; msg = String(e); }
  check("oversized body: throws bounded cap error",
    threw && msg.includes("1048576"), `threw=${threw} msg="${msg.slice(0,80)}"`);
  check("stream cancelled at cap: server sent ≈ cap bytes, not ~64 MiB",
    overflowBytesSent <= CAP + 65536,
    `bytesSent=${overflowBytesSent} (cap=${CAP}, would-stream=${WOULD_STREAM})`);

  // B: Happy path
  const resB = await fetch(`http://127.0.0.1:${smallPort}/`);
  const buf = await readResponseWithLimit(resB, CAP, {
    onOverflow: ({ maxBytes }) => new Error(`JSON response exceeds ${maxBytes} bytes`),
  });
  const json = JSON.parse(buf.toString("utf8"));
  check("happy path: small JSON parsed correctly",
    json.status === "ok" && json.id === "batch-1",
    `status=${json.status} id=${json.id}`);

  // C: Negative control
  const resC = await fetch(`http://127.0.0.1:${overflowPort}/`);
  const raw = await resC.arrayBuffer();
  check("negative control: unbounded read buffers PAST cap",
    raw.byteLength > CAP,
    `buffered=${raw.byteLength} bytes (> ${CAP})`);

} finally {
  overflowServer.close();
  smallServer.close();
}

console.log("");
console.log(`[proof] ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
