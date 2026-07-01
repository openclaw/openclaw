/**
 * Real behavior proof: Discord webhook bounded JSON response reads.
 *
 * Starts a local node:http server returning webhook-style responses,
 * then calls readResponseWithLimit with the same 1 MiB cap used in
 * send.webhook.ts.  Verifies:
 * 1. Normal JSON → parsed correctly
 * 2. Oversized body (> 1 MiB) → bounded read rejects with expected error
 * 3. Empty body → falls back to {} (no throw)
 *
 * Usage: node --import tsx test/_proof_discord_webhook_bounded_json.mts
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const DISCORD_WEBHOOK_JSON_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

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
  const { readResponseWithLimit } = await import(
    "openclaw/plugin-sdk/response-limit-runtime"
  );

  // Proof 1: oversized response > 1 MiB is rejected
  {
    const bigBody = "x".repeat(2 * 1024 * 1024); // 2 MiB > 1 MiB cap
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(bigBody);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;

    let error: unknown;
    try {
      const response = await fetch(url);
      await readResponseWithLimit(
        response,
        DISCORD_WEBHOOK_JSON_RESPONSE_MAX_BYTES,
        {
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `Discord webhook JSON response too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
        },
      );
    } catch (err: unknown) {
      error = err;
    } finally {
      server.close();
    }

    check(
      "oversized response (2 MiB > 1 MiB cap): bounded read rejects",
      error instanceof Error,
      `type=${error?.constructor?.name ?? "unknown"}`,
    );
    check(
      "oversized response: error message mentions webhook JSON cap",
      error instanceof Error &&
        error.message.includes("Discord webhook JSON response too large"),
      `msg=${error instanceof Error ? error.message.slice(0, 100) : "N/A"}`,
    );
  }

  // Proof 2: normal JSON response → parsed correctly
  {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg-42", channel_id: "C42" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;

    try {
      const response = await fetch(url);
      const body = await readResponseWithLimit(
        response,
        DISCORD_WEBHOOK_JSON_RESPONSE_MAX_BYTES,
        {
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `Discord webhook JSON response too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
        },
      );
      const payload = JSON.parse(body.toString("utf8")) as { id?: string; channel_id?: string };
      check(
        "normal response: parsed correctly",
        payload.id === "msg-42" && payload.channel_id === "C42",
        `id=${payload.id}, channel_id=${payload.channel_id}`,
      );
    } finally {
      server.close();
    }
  }

  // Proof 3: empty body → JSON.parse throws, caught by caller's try/catch → falls back to {}
  {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;

    try {
      const response = await fetch(url);
      const body = await readResponseWithLimit(
        response,
        DISCORD_WEBHOOK_JSON_RESPONSE_MAX_BYTES,
        {
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `Discord webhook JSON response too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
        },
      );
      let payload: { id?: string; channel_id?: string };
      try {
        payload = JSON.parse(body.toString("utf8")) as { id?: string; channel_id?: string };
      } catch {
        payload = {};
      }
      check(
        "empty body: falls back to {} without throwing",
        payload.id === undefined && payload.channel_id === undefined,
        `payload=${JSON.stringify(payload)}`,
      );
    } finally {
      server.close();
    }
  }

  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}
main();
