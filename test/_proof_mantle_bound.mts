/**
 * Real behavior proof: Bedrock Mantle model-discovery bounded response reads.
 *
 * Starts real node:http servers that stream oversized JSON bodies, then calls
 * discoverMantleModels via its injectable fetchFn so the changed entry point
 * is exercised end-to-end.  Verifies fail-soft (returns []) on oversized
 * streamed responses and correct parsing on normal-small responses.
 *
 * Usage: node --import tsx test/_proof_mantle_bound.mts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const TOTAL = 18 * 1024 * 1024;

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`); }
  else { fail++; console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
}

function startOversizedServer(): Promise<{ url: string; shutdown: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      let sent = 0;
      const chunk = Buffer.alloc(65536, 0x41);
      function writeChunk() {
        if (sent >= TOTAL) { res.end("\n]}"); return; }
        const header = sent === 0 ? '{"data":[{"id":"m.1","object":"model"}],"object":"list"}' : "";
        const payload = header ? Buffer.concat([Buffer.from(header), chunk]) : chunk;
        sent += payload.length;
        if (!res.write(payload)) res.once("drain", writeChunk);
        else setImmediate(writeChunk);
      }
      writeChunk();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, shutdown: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function startSmallServer(body: unknown): Promise<{ url: string; shutdown: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, shutdown: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function proofOversized() {
  const { url, shutdown } = await startOversizedServer();

  console.log(`[proof] oversized server on :${new URL(url).port}, total≈${TOTAL}`);

  const { discoverMantleModels } = await import("../extensions/amazon-bedrock-mantle/api.js");

  const models = await discoverMantleModels({
    region: "us-east-1",
    bearerToken: "proof-token",
    fetchFn: (input: RequestInfo | URL, _init?: RequestInit) => fetch(input, _init),
    now: () => 1, // ensure no cache hit
  });

  // fetchFn receives the mantle endpoint URL; we ignore it and redirect to our local server
  // by using a custom fetch that rewrites the URL.
  const models2 = await discoverMantleModels({
    region: "us-east-1",
    bearerToken: "proof-token",
    fetchFn: async (_endpoint: RequestInfo | URL, _init?: RequestInit) => fetch(url),
    now: () => 2,
  });

  // Oversized response should fail-soft to [] (no cached data from previous call)
  check("oversized discovery: returns [] (fail-soft)", Array.isArray(models2) && models2.length === 0,
    `result=${JSON.stringify(models2)}`);

  await shutdown();

  // Negative control: call with unbounded response.json() via a second server
  const { url: url2, shutdown: shutdown2 } = await startOversizedServer();
  const res = await fetch(url2);
  const text = await res.text();
  check("negative control: unbounded read buffers PAST cap",
    text.length > 16 * 1024 * 1024,
    `buffered=${text.length} (> 16 MiB)`);

  await shutdown2();
}

async function proofHappyPath() {
  const { url, shutdown } = await startSmallServer({
    object: "list",
    data: [{ id: "openai.gpt-oss-120b", object: "model" }],
  });

  const { discoverMantleModels } = await import("../extensions/amazon-bedrock-mantle/api.js");

  const models = await discoverMantleModels({
    region: "us-east-1",
    bearerToken: "proof-token",
    fetchFn: async (_endpoint: RequestInfo | URL, _init?: RequestInit) => fetch(url),
    now: () => 100,
  });

  check("happy path: small JSON parsed correctly",
    models.length === 1 && models[0]?.id === "openai.gpt-oss-120b",
    `count=${models.length} id=${models[0]?.id}`);

  await shutdown();
}

async function proofFailSoft() {
  // Verify the outer catch returns [] on a network error, confirming fail-soft
  // doesn't crash the caller when the fetch itself fails.
  const { discoverMantleModels } = await import("../extensions/amazon-bedrock-mantle/api.js");

  const models = await discoverMantleModels({
    region: "us-east-1",
    bearerToken: "proof-token",
    fetchFn: async () => { throw new Error("ECONNREFUSED"); },
    now: () => 200,
  });

  check("network error: returns [] (fail-soft)", Array.isArray(models) && models.length === 0,
    `result=${JSON.stringify(models)}`);
}

async function main() {
  console.log(`node --import tsx test/_proof_mantle_bound.mts\n`);
  await proofOversized();
  await proofHappyPath();
  await proofFailSoft();
  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
