import http from "node:http";
import net from "node:net";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { mockIpv4OnlyLocalhostLookup } from "../../test/helpers/loopback-dns.js";
import { hasErrnoCode } from "../infra/errno.js";
import { invokeNodeWorkerPortalStream } from "./portal-stream-command.js";

const TICKET = "a".repeat(48);
const cleanups: Array<() => Promise<void>> = [];
function portOf(server: net.Server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected test address");
  }
  return address.port;
}
function closeServer(server: net.Server, peers: Iterable<{ destroy(): void }> = []) {
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const peer of peers) {
          peer.destroy();
        }
        server.close(() => resolve());
      }),
  );
}

/** Resolves false when the host has no IPv6 (some containers) instead of hanging. */
async function listenUnlessIpv6Unavailable(
  server: net.Server,
  options: net.ListenOptions,
): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const onError = (error: Error) =>
      hasErrnoCode(error, "EAFNOSUPPORT") || hasErrnoCode(error, "EADDRNOTAVAIL")
        ? resolve(false)
        : reject(error);
    server.once("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resolve(true);
    });
  });
}

async function listenGateway(contextPath = "") {
  const peer: {
    socket?: WebSocket;
    headers: Array<string | undefined>;
    frames: Buffer[];
    closed: boolean;
  } = {
    headers: [],
    frames: [],
    closed: false,
  };
  const server = http.createServer();
  // Reserve both families so this HTTP peer cannot take the IPv6 target's
  // numeric port on IPv4 and win localhost connection selection. Without IPv6
  // there is no IPv6 target to protect.
  if (!(await listenUnlessIpv6Unavailable(server, { port: 0, host: "::", ipv6Only: false }))) {
    await listenUnlessIpv6Unavailable(server, { port: 0, host: "127.0.0.1" });
  }
  // Attach after listening: ws re-emits server listen errors on the WebSocketServer.
  const wss = new WebSocketServer({
    server,
    path: `${contextPath.replace(/\/$/u, "")}/node-portal/attach`,
  });
  wss.on("connection", (ws, request) => {
    peer.socket = ws;
    peer.headers = ["cf-access-client-id", "cf-access-client-secret"].map((name) =>
      request.headers[name]?.toString(),
    );
    ws.on("message", (data, binary) => {
      expect(binary).toBe(true);
      if (!Buffer.isBuffer(data)) {
        throw new Error("expected binary portal stream frame");
      }
      peer.frames.push(data);
    });
    ws.once("close", () => {
      peer.closed = true;
    });
  });
  const port = portOf(server);
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => server.close(() => resolve()));
      }),
  );
  return { peer, gatewayUrl: `ws://127.0.0.1:${port}${contextPath}` };
}
function invokePortal(
  port: number,
  options: Partial<Parameters<typeof invokeNodeWorkerPortalStream>[0]> = {},
) {
  return invokeNodeWorkerPortalStream({
    paramsJSON: portalCommand(port),
    gatewayUrl: "ws://127.0.0.1:1",
    signal: new AbortController().signal,
    ...options,
  });
}

function portalCommand(port: number, override: object = {}) {
  return JSON.stringify({
    ticket: TICKET,
    attachPath: `/node-portal/attach?ticket=${TICKET}`,
    port,
    ...override,
  });
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it.each([
  ["missing ticket", { ticket: undefined }],
  ["invalid ticket", { ticket: "invalid" }],
  ["cross-origin attach path", { attachPath: `//attacker.example/attach?ticket=${TICKET}` }],
  ["desktop attach path", { attachPath: `/node-desktop/attach?ticket=${TICKET}` }],
  ["invalid port", { port: 65_536 }],
  ["caller-selected host", { host: "192.0.2.10" }],
])("rejects a request with %s", async (_name, override) => {
  await expect(
    invokePortal(8080, {
      paramsJSON: portalCommand(8080, override),
    }),
  ).rejects.toThrow("INVALID_REQUEST");
});

it.for([
  ["127.0.0.1", ""],
  ["::1", ""],
  ["127.0.0.1", "/openclaw-gw"],
  ["127.0.0.1", "/openclaw-gw/"],
] as const)(
  "attaches %s loopback through Gateway context %j and closes on cancellation",
  async ([host, contextPath], { skip }) => {
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
    if (!(await listenUnlessIpv6Unavailable(local, { port: 0, host }))) {
      skip("IPv6 loopback is unavailable on this host");
    }
    closeServer(local, peers);

    const { peer, gatewayUrl } = await listenGateway(contextPath);
    const controller = new AbortController();
    const running = invokePortal(portOf(local), {
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

    await vi.waitFor(() => expect(peer.frames).toHaveLength(1));
    expect(peer.frames[0]?.toString("utf8")).toBe(JSON.stringify({ ok: true }));
    expect(peer.headers).toEqual(["portal-client-id", "portal-client-secret"]);
    peer.socket?.send(Buffer.from("hello"), { binary: true });
    await vi.waitFor(() => expect(peer.frames[1]?.toString("utf8")).toBe("echo:hello"));

    controller.abort();

    await expect(running).resolves.toBeUndefined();
    await vi.waitFor(() => expect(peer.closed).toBe(true));
    await vi.waitFor(() => expect(peers.size).toBe(0));
  },
);

it("closes an attached Gateway socket without a readiness frame when loopback refuses", async () => {
  const { peer, gatewayUrl } = await listenGateway();
  const reservedTarget = net.createServer();
  await listenUnlessIpv6Unavailable(reservedTarget, { port: 0, host: "127.0.0.1" });
  const targetPort = portOf(reservedTarget);
  closeServer(reservedTarget);
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
    if (port === targetPort && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
      refusedTargets++;
      queueMicrotask(() =>
        this.destroy(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
      );
      return this;
    }
    return Reflect.apply(originalConnect, this, args);
  });

  try {
    await expect(invokePortal(targetPort, { gatewayUrl })).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });

    expect(refusedTargets).toBe(1);
    expect(peer.socket).toBeDefined();
    await vi.waitFor(() => expect(peer.closed).toBe(true));
    expect(peer.frames).toEqual([]);
  } finally {
    connect.mockRestore();
  }
});
