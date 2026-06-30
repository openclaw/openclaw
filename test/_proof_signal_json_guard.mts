/**
 * Real behavior proof: containerRestRequest malformed JSON → Error.
 *
 * Starts a local node:http server that returns malformed JSON, then calls
 * containerRestRequest pointing at it.  This exercises the ACTUAL changed
 * try/catch code path through the real fetch stack (no mock).
 *
 * Usage: node --import tsx test/_proof_signal_json_guard.mts
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
  // Start a local HTTP server that returns malformed JSON
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("NOT JSON {{{");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const { containerRestRequest } = await import(
    "../extensions/signal/src/client-container.js"
  );

  try {
    // Proof 1: malformed JSON → descriptive Error
    let error: unknown;
    try {
      await containerRestRequest("/v1/test", { baseUrl });
    } catch (err: unknown) {
      error = err;
    }

    check(
      "malformed JSON: throws Error",
      error instanceof Error,
      `type=${error?.constructor?.name ?? "unknown"}`,
    );
    check(
      "malformed JSON: message describes malformed JSON",
      error instanceof Error &&
        error.message.includes("Signal REST returned malformed JSON"),
      `msg=${error instanceof Error ? JSON.stringify(error.message) : "N/A"}`,
    );
    check(
      "malformed JSON: NOT raw SyntaxError",
      !(error instanceof SyntaxError),
      `type=${error?.constructor?.name ?? "unknown"}`,
    );

    console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
    if (fail > 0) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main();
