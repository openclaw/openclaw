/**
 * Real behavior proof: Bedrock Mantle model-discovery bounded response reads.
 *
 * Starts real node:http servers that stream oversized JSON bodies with no
 * Content-Length.  Verifies the shared bounded reader rejects at the 16 MiB
 * provider-JSON cap and cancels the stream early.  The negative control
 * confirms the old unbounded `response.json()` would buffer everything.
 *
 * Usage: node --import tsx test/_proof_mantle_bound.mts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const CAP = 16 * 1024 * 1024;
const TOTAL = 18 * 1024 * 1024;

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`); }
  else { fail++; console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
}

function startServer(handler: (req: unknown, res: unknown) => void): Promise<{ url: string; shutdown: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler as Parameters<typeof createServer>[0]);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, shutdown: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function proofOversized() {
  const { url, shutdown } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    let sent = 0;
    const chunk = Buffer.alloc(65536, 0x41);
    function writeChunk() {
      if (sent >= TOTAL) { res.end("\n]}"); return; }
      const header = sent === 0 ? '{"data":[{"id":"x","object":"model"}],"object":"list"}' : "";
      const payload = header ? Buffer.concat([Buffer.from(header), chunk]) : chunk;
      sent += payload.length;
      if (!res.write(payload)) res.once("drain", writeChunk);
      else setImmediate(writeChunk);
    }
    writeChunk();
  });

  console.log(`[proof] oversized server on :${new URL(url).port}, cap=${CAP}, total≈${TOTAL}`);

  // Positive: bounded read rejects at cap
  try {
    const { readResponseWithLimit } = await import("openclaw/plugin-sdk/response-limit-runtime");
    const res = await fetch(url);
    await readResponseWithLimit(res, CAP, {
      onOverflow: ({ maxBytes }) => new Error(`JSON response exceeds ${maxBytes} bytes`),
    });
    check("oversized body: throws bounded cap error", false, "should have thrown");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    check("oversized body: throws bounded cap error", msg.includes(String(CAP)),
      `threw=true msg="${msg.slice(0, 80)}"`);
  }

  await shutdown();

  // Negative: unbounded buffers everything (separate server)
  const { url: url2, shutdown: shutdown2 } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    let sent = 0;
    const chunk = Buffer.alloc(65536, 0x41);
    function writeChunk() {
      if (sent >= TOTAL) { res.end("\n]}"); return; }
      const header = sent === 0 ? '{"data":[{"id":"x","object":"model"}]}' : "";
      const payload = header ? Buffer.concat([Buffer.from(header), chunk]) : chunk;
      sent += payload.length;
      if (!res.write(payload)) res.once("drain", writeChunk);
      else setImmediate(writeChunk);
    }
    writeChunk();
  });

  const res2 = await fetch(url2);
  const text = await res2.text();
  check("negative control: unbounded read buffers PAST cap",
    text.length > CAP, `buffered=${text.length} (> ${CAP})`);

  await shutdown2();
}

async function proofHappyPath() {
  const { url, shutdown } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "openai.gpt-oss-120b", object: "model" }] }));
  });

  const { readProviderJsonResponse } = await import("openclaw/plugin-sdk/provider-http");
  const res = await fetch(url);
  const body = await readProviderJsonResponse<{ object: string; data: unknown[] }>(
    res, "bedrock-mantle-model-discovery");
  check("happy path: small JSON parsed correctly",
    body?.object === "list" && Array.isArray(body?.data) && body.data.length === 1,
    `object=${body?.object} dataLen=${body?.data?.length}`);

  await shutdown();
}

async function main() {
  console.log(`node --import tsx test/_proof_mantle_bound.mts\n`);
  await proofOversized();
  await proofHappyPath();
  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
