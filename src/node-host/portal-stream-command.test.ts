import net from "node:net";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { mockIpv4OnlyLocalhostLookup } from "../../test/helpers/loopback-dns.js";
import { NODE_WORKER_PORTAL_STREAM_COMMAND } from "../infra/node-commands.js";
import * as logger from "../logger.js";
import { invokeNodeWorkerSupervisorCommand } from "./node-worker-supervisor-commands.js";
import type { NodeWorkerSupervisorControl } from "./node-worker-supervisor-contract.js";
import {
  listen,
  portOf,
  streamParams,
  TICKET,
  useStreamFixture,
} from "./stream-command.test-support.js";

const { cleanups, closeServer, gateway } = useStreamFixture();
const unexpectedSupervisorCommand = async (): Promise<never> => {
  throw new Error("Portal stream must not call another supervisor command");
};
const portalSupervisor: NodeWorkerSupervisorControl = {
  launch: unexpectedSupervisorCommand,
  status: unexpectedSupervisorCommand,
  retainWorkspaces: unexpectedSupervisorCommand,
  cancel: unexpectedSupervisorCommand,
  observeProcesses: unexpectedSupervisorCommand,
  stopEnvironment: unexpectedSupervisorCommand,
};
function invokePortal(
  port: number,
  options: Partial<
    Omit<Parameters<typeof invokeNodeWorkerSupervisorCommand>[0], "command" | "supervisor">
  > = {},
) {
  return invokeNodeWorkerSupervisorCommand({
    command: NODE_WORKER_PORTAL_STREAM_COMMAND,
    supervisor: portalSupervisor,
    paramsJSON: portalCommand(port),
    gatewayUrl: "ws://127.0.0.1:1",
    signal: new AbortController().signal,
    ...options,
  });
}

function portalCommand(port: number, override: object = {}) {
  return streamParams("portal", { port, ...override });
}

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
  ).resolves.toMatchObject({
    handled: true,
    ok: false,
    code: "INVALID_REQUEST",
    message: "INVALID_REQUEST: invalid node worker portal stream request",
  });
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
    if (!(await listen(local, { port: 0, host }))) {
      skip("IPv6 loopback is unavailable on this host");
    }
    closeServer(local, peers);

    const { peer, gatewayUrl } = await gateway("portal", contextPath);
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

    await expect(running).resolves.toEqual({ handled: true, ok: true, payload: null });
    await vi.waitFor(() => expect(peer.closed).toBe(true));
    await vi.waitFor(() => expect(peers.size).toBe(0));
  },
);

it("closes an attached Gateway socket without a readiness frame when loopback refuses", async () => {
  const { peer, gatewayUrl } = await gateway("portal");
  const reservedTarget = net.createServer();
  await listen(reservedTarget);
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

  const warning = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
  try {
    await expect(invokePortal(targetPort, { gatewayUrl })).resolves.toEqual({
      handled: true,
      ok: false,
      code: "UNAVAILABLE",
      message: "node worker supervisor command failed",
    });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    expect(refusedTargets).toBe(1);
    expect(peer.socket).toBeDefined();
    await vi.waitFor(() => expect(peer.closed).toBe(true));
    expect(peer.frames).toEqual([]);
  } finally {
    connect.mockRestore();
    warning.mockRestore();
  }
});
