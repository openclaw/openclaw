/**
 * Real behavior proof: CDP fetchJson rejects oversized JSON responses.
 *
 * Starts a local node:http server that returns a response exceeding the
 * 16 MiB cap, then calls fetchJson against it.  Verifies the bounded
 * reader rejects with the expected error instead of buffering the body.
 *
 * Usage: node --import tsx test/_proof_cdp_bounded_json.mts
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
    fail++;
  }
}

async function main() {
  // Oversized body: ~17 MiB (exceeds 16 MiB cap)
  const bigBody = "x".repeat(17 * 1024 * 1024);

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(bigBody);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const { fetchJson } = await import(
    "../extensions/browser/src/browser/cdp.helpers.js"
  );

  try {
    // Proof 1: oversized response is rejected
    let error: unknown;
    try {
      await fetchJson(`${baseUrl}/json/version`, 5000, undefined, {
        dangerouslyAllowPrivateNetwork: true,
        allowedHostnames: ["127.0.0.1"],
      });
    } catch (err: unknown) {
      error = err;
    }

    check(
      "oversized CDP response: throws Error",
      error instanceof Error,
      `type=${error?.constructor?.name ?? "unknown"}`,
    );
    check(
      "oversized CDP response: message mentions CDP JSON",
      error instanceof Error &&
        error.message.includes("CDP JSON response too large"),
      `msg=${error instanceof Error ? error.message.slice(0, 100) : "N/A"}`,
    );

    // Proof 2: normal response succeeds
    const normalServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: "42" }));
    });
    await new Promise<void>((r) => normalServer.listen(0, "127.0.0.1", r));
    const normAddr = normalServer.address() as AddressInfo;
    const normUrl = `http://127.0.0.1:${normAddr.port}`;

    try {
      const result = await fetchJson(`${normUrl}/json/version`, 5000, undefined, {
        dangerouslyAllowPrivateNetwork: true,
        allowedHostnames: ["127.0.0.1"],
      });
      check(
        "normal CDP response: parsed correctly",
        (result as Record<string, unknown>)?.id === "42",
        `result=${JSON.stringify(result)}`,
      );
    } finally {
      normalServer.close();
    }
  } finally {
    server.close();
  }

  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}
main();
