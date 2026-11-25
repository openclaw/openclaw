#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";

const configPath = process.env.OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER;
if (!configPath) throw new Error("Missing browser-login edge fixture configuration");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const args = process.argv.slice(2);
if (args.join(" ") === "version") {
  process.stdout.write("browser-login-fixture\n");
} else if (args.join(" ") === "status --json") {
  process.stdout.write(JSON.stringify({ Self: { DNSName: `${config.hostname}.` } }));
} else if (args.join(" ") === "serve status --json") {
  process.stdout.write("{}");
} else if (
  args.length === 4 &&
  args[0] === "serve" &&
  args[1] === "--yes" &&
  args[2] === "--bg=false" &&
  Number.isInteger(Number(args[3])) &&
  Number(args[3]) > 0
) {
  const target = Number(args[3]);
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const headers = (incoming) => ({
    ...incoming.headers,
    "x-forwarded-for": "100.64.0.20",
    "x-forwarded-proto": "https",
    "x-forwarded-host": config.hostname,
  });
  const server = createServer(
    {
      key: readFileSync(config.keyPath),
      cert: readFileSync(config.certPath),
    },
    (incoming, response) => {
      const upstream = request(
        {
          hostname: "127.0.0.1",
          port: target,
          path: incoming.url,
          method: incoming.method,
          headers: headers(incoming),
        },
        (result) => {
          response.writeHead(result.statusCode, result.headers);
          result.pipe(response);
        },
      );
      upstream.on("socket", track);
      upstream.on("error", () => response.destroy());
      incoming.pipe(upstream);
    },
  );
  server.on("connection", track);
  server.on("upgrade", (incoming, downstream, head) => {
    const upstream = track(connect(target, "127.0.0.1"));
    upstream.once("connect", () => {
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/1.1\r\n` +
          Object.entries(headers(incoming))
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join("") +
          "\r\n",
      );
      if (head.length) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
  });
  const stop = () => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen(config.port, "127.0.0.1", () => {
    writeFileSync(
      config.receiptPath,
      JSON.stringify({ pid: process.pid, target, port: config.port }),
    );
    process.stdout.write("Press Ctrl+C to exit.\n");
  });
} else {
  throw new Error(`Unsupported browser-login fixture invocation: ${JSON.stringify(args)}`);
}
