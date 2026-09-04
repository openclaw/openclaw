import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { probeOwnedGatewayReadiness } from "./gateway-readiness-probe.js";
import { createDeferred } from "./promise.js";

describe("owned readiness transport", () => {
  it.for(["headers", "body", "upgrade", "replacement"] as const)(
    "joins the socket without accepting readiness after %s failure",
    async (phase, { signal }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-readiness-transport-"));
      const configPath = path.join(root, "openclaw.json");
      await fs.writeFile(configPath, "{}");
      const reached = createDeferred();
      const closed: Promise<void>[] = [];
      const peers = new Set<Socket>();
      const retirePeers = () => {
        for (const peer of peers) {
          peer.destroy();
        }
      };
      signal.addEventListener("abort", retirePeers, { once: true });
      const controller = new AbortController();
      const server = createServer((_request, response) => {
        if (phase === "headers") {
          reached.resolve();
          return;
        }
        response.writeHead(200, { Connection: phase === "replacement" ? "close" : "keep-alive" });
        if (phase === "body") {
          response.write('{"ready":');
          reached.resolve();
        } else {
          // An HTTP success alone must never be a successful probe, including
          // when that socket closes before the standard Gateway handshake.
          response.end('{"ready":true}');
        }
      });
      server.on("connection", (socket) => {
        peers.add(socket);
        closed.push(
          new Promise((resolve) => {
            socket.once("close", () => {
              peers.delete(socket);
              resolve();
            });
          }),
        );
      });
      server.on("upgrade", (_request, socket) => {
        // This deliberately incomplete upgrade has no WebSocket server to
        // finish a half-close; observe the client's EOF and retire the peer.
        socket.once("end", () => socket.destroy());
        socket.resume();
        reached.resolve();
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing readiness fixture address");
      }
      const probing = probeOwnedGatewayReadiness({
        port: address.port,
        configPath,
        env: {},
        stateDir: root,
        pid: process.pid,
        startedAt: Date.now(),
        signal: AbortSignal.any([controller.signal, signal]),
      }).catch((error: unknown) => error);
      try {
        if (phase !== "replacement") {
          await Promise.race([
            reached.promise,
            probing.then(() => {
              throw new Error("probe settled before reaching the fault");
            }),
          ]);
          controller.abort();
        }
        expect(await probing).not.toBe(true);
        await Promise.all(closed);
        expect(closed).toHaveLength(1);
        expect(await fs.readdir(root)).toEqual(["openclaw.json"]);
      } finally {
        controller.abort();
        await probing;
        retirePeers();
        signal.removeEventListener("abort", retirePeers);
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
