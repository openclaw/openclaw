import http from "node:http";
import net from "node:net";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { mockIpv4OnlyLocalhostLookup } from "../../test/helpers/loopback-dns.js";
import { invokeNodeWorkerPortalStream } from "./portal-stream-command.js";

const TICKET = "a".repeat(48);
const cleanups: Array<() => Promise<void>> = [];

async function listenGateway(
  onConnection: (ws: WebSocket, request: http.IncomingMessage) => void,
  contextPath = "",
) {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    path: `${contextPath.replace(/\/$/u, "")}/node-portal/attach`,
  });
  wss.on("connection", onConnection);
  await new Promise<void>((resolve) => {
    // Reserve both families so this HTTP peer cannot take the IPv6 target's
    // numeric port on IPv4 and win localhost connection selection.
    server.listen({ port: 0, host: "::", ipv6Only: false }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected Gateway test address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => server.close(() => resolve()));
      }),
  );
  return `ws://127.0.0.1:${address.port}${contextPath}`;
}

function portalCommand(port: number) {
  return JSON.stringify({
    ticket: TICKET,
    attachPath: `/node-portal/attach?ticket=${TICKET}`,
    port,
  });
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("node worker portal stream command", () => {
  it.each([
    ["missing ticket", { ticket: undefined }],
    ["invalid ticket", { ticket: "invalid" }],
    ["cross-origin attach path", { attachPath: `//attacker.example/attach?ticket=${TICKET}` }],
    ["desktop attach path", { attachPath: `/node-desktop/attach?ticket=${TICKET}` }],
    ["invalid port", { port: 65_536 }],
    ["caller-selected host", { host: "192.0.2.10" }],
  ])("rejects a request with %s", async (_name, override) => {
    await expect(
      invokeNodeWorkerPortalStream({
        paramsJSON: JSON.stringify({
          ticket: TICKET,
          attachPath: `/node-portal/attach?ticket=${TICKET}`,
          port: 8080,
          ...override,
        }),
        gatewayUrl: "ws://127.0.0.1:1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("INVALID_REQUEST");
  });

  it.each([
    ["127.0.0.1", ""],
    ["::1", ""],
    ["127.0.0.1", "/openclaw-gw"],
    ["127.0.0.1", "/openclaw-gw/"],
  ])(
    "attaches %s loopback through Gateway context %j and closes on cancellation",
    async (host, contextPath) => {
      if (host === "::1") {
        mockIpv4OnlyLocalhostLookup();
      }
      const peers = new Set<net.Socket>();
      const local = net.createServer((socket) => {
        peers.add(socket);
        socket.once("close", () => peers.delete(socket));
        socket.on("data", (chunk) =>
          socket.write(Buffer.concat([Buffer.from("echo:"), Buffer.from(chunk)])),
        );
      });
      await new Promise<void>((resolve) => {
        local.listen(0, host, resolve);
      });
      const address = local.address();
      if (!address || typeof address === "string") {
        throw new Error("expected portal loopback test address");
      }
      cleanups.push(
        async () =>
          await new Promise<void>((resolve) => {
            for (const peer of peers) {
              peer.destroy();
            }
            local.close(() => resolve());
          }),
      );

      const frames: Buffer[] = [];
      let attached: WebSocket | undefined;
      let accessHeaders: [string | undefined, string | undefined] | undefined;
      let closed = false;
      const gatewayUrl = await listenGateway((ws, request) => {
        attached = ws;
        accessHeaders = [
          request.headers["cf-access-client-id"]?.toString(),
          request.headers["cf-access-client-secret"]?.toString(),
        ];
        ws.on("message", (data, isBinary) => {
          expect(isBinary).toBe(true);
          if (!Buffer.isBuffer(data)) {
            throw new Error("expected binary portal stream frame");
          }
          frames.push(data);
        });
        ws.once("close", () => {
          closed = true;
        });
      }, contextPath);
      const controller = new AbortController();
      const running = invokeNodeWorkerPortalStream({
        paramsJSON: portalCommand(address.port),
        gatewayUrl,
        gatewayCloudflareAccess: {
          clientId: "portal-client-id",
          clientSecret: "portal-client-secret",
        },
        signal: controller.signal,
      });
      cleanups.push(async () => {
        controller.abort();
        await running.catch(() => undefined);
      });
      void running.catch(() => undefined);

      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]?.toString("utf8")).toBe(JSON.stringify({ ok: true }));
      expect(accessHeaders).toEqual(["portal-client-id", "portal-client-secret"]);
      attached?.send(Buffer.from("hello"), { binary: true });
      await vi.waitFor(() => expect(frames[1]?.toString("utf8")).toBe("echo:hello"));

      controller.abort();

      await expect(running).resolves.toBeUndefined();
      await vi.waitFor(() => expect(closed).toBe(true));
      await vi.waitFor(() => expect(peers.size).toBe(0));
    },
  );

  it("closes an attached Gateway socket without a readiness frame when loopback refuses", async () => {
    let attached = false;
    let closed = false;
    const frames: unknown[] = [];
    const gatewayUrl = await listenGateway((ws) => {
      attached = true;
      ws.on("message", (data) => frames.push(data));
      ws.once("close", () => {
        closed = true;
      });
    });
    const reservedTarget = net.createServer();
    await new Promise<void>((resolve, reject) => {
      reservedTarget.once("error", reject);
      reservedTarget.listen(0, "127.0.0.1", () => {
        reservedTarget.off("error", reject);
        resolve();
      });
    });
    const address = reservedTarget.address();
    if (!address || typeof address === "string") {
      throw new Error("expected reserved portal test address");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          reservedTarget.close(() => resolve());
        }),
    );
    let refusedTargets = 0;
    // Preserve each caller's native socket through Reflect.apply below.
    // oxlint-disable-next-line typescript/unbound-method
    const originalConnect = net.Socket.prototype.connect;
    // A released port can be reclaimed by another test before this connection.
    const connect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      const normalized = Array.isArray(args[0]) ? args[0] : args;
      const options = isRecord(normalized[0]) ? normalized[0] : undefined;
      const host = options?.host ?? normalized[1];
      const port = Number(options?.port ?? normalized[0]);
      if (
        port === address.port &&
        (host === "localhost" || host === "127.0.0.1" || host === "::1")
      ) {
        refusedTargets++;
        queueMicrotask(() =>
          this.destroy(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
        );
        return this;
      }
      return Reflect.apply(originalConnect, this, args);
    });

    try {
      await expect(
        invokeNodeWorkerPortalStream({
          paramsJSON: portalCommand(address.port),
          gatewayUrl,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "ECONNREFUSED" });

      expect(refusedTargets).toBe(1);
      expect(attached).toBe(true);
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(frames).toEqual([]);
    } finally {
      connect.mockRestore();
    }
  });
});
