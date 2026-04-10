#!/usr/bin/env node
"use strict";

const net = require("net");

const args = process.argv.slice(2);

function readArg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  const value = Number(args[idx + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const listenPort = readArg("--listen-port", 9334);
const targetPort = readArg("--target-port", 9333);
const targetHost = "127.0.0.1";

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: targetPort });

  client.pipe(upstream);
  upstream.pipe(client);

  const cleanup = () => {
    if (!client.destroyed) client.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };

  client.on("error", cleanup);
  upstream.on("error", cleanup);
  client.on("close", cleanup);
  upstream.on("close", cleanup);
});

server.on("error", (err) => {
  process.stderr.write(`[cdp-proxy] server error: ${err.message}\n`);
  process.exit(1);
});

server.listen(listenPort, "0.0.0.0", () => {
  process.stdout.write(
    `[cdp-proxy] listening on 0.0.0.0:${listenPort}, forwarding to ${targetHost}:${targetPort}\n`
  );
});
