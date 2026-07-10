import { once } from "node:events";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket, { type RawData } from "ws";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { setDefaultSecurityHeaders } from "../http-common.js";
import { resolveRequestClientIp } from "../net.js";
import {
  GUEST_WS_SUBPROTOCOL,
  GuestAccessController,
  type GuestAccessControllerOptions,
  type GuestRedeemSuccess,
} from "./access-controller.js";
import { GuestConnectionRegistry, type GuestSocket } from "./connection-registry.js";
import { GuestGrantStore, type GuestGrant } from "./grant-store.js";

export type GuestTestHarness = Awaited<ReturnType<typeof createGuestTestHarness>>;

export class RecordingGuestSocket implements GuestSocket {
  readonly closes: Array<{ code: number; reason: string }> = [];

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

export function createManualGate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await released;
    },
  };
}

export function createRendezvous(parties: number) {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === parties) {
      release();
    }
    await released;
  };
}

export async function createGuestTestHarness(
  options: Omit<GuestAccessControllerOptions, "store" | "connections"> & {
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    connections?: GuestConnectionRegistry;
  } = {},
) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-guest-w1-"));
  const store = new GuestGrantStore({
    stateDir,
    ...(options.now ? { now: options.now } : {}),
  });
  const connections =
    options.connections ?? new GuestConnectionRegistry(options.now ? { now: options.now } : {});
  const controller = new GuestAccessController({ ...options, store, connections });
  const sockets = new Set<WebSocket>();
  const server = createServer((req, res) => {
    setDefaultSecurityHeaders(res);
    const clientIp = resolveRequestClientIp(
      req,
      options.trustedProxies ?? [],
      options.allowRealIpFallback ?? false,
    );
    void controller.handleHttpRequest(req, res, { clientIp }).then((handled) => {
      if (!handled && !res.writableEnded) {
        res.statusCode = 404;
        res.end("Not Found");
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    void controller.handleUpgrade(req, socket, head).then((handled) => {
      if (!handled) {
        socket.destroy();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("guest test server did not bind a TCP port");
  }
  const httpBase = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;

  const createGrant = (
    overrides: Partial<
      Pick<
        GuestGrant,
        "audience" | "expiresAtMs" | "invitedPrincipal" | "maxConcurrentGuests" | "sessionKey"
      >
    > = {},
  ) =>
    store.createGrant({
      sessionKey: overrides.sessionKey ?? "agent:main:guest-w1",
      audience: overrides.audience ?? "open",
      ...(overrides.invitedPrincipal ? { invitedPrincipal: overrides.invitedPrincipal } : {}),
      createdBy: "device:w1-host",
      ...(overrides.expiresAtMs === undefined ? {} : { expiresAtMs: overrides.expiresAtMs }),
      ...(overrides.maxConcurrentGuests === undefined
        ? {}
        : { maxConcurrentGuests: overrides.maxConcurrentGuests }),
    });

  const redeem = async (
    code: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${httpBase}/guest/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ code, ...body }),
    });
    const payload = (await response.json()) as unknown;
    return { response, payload };
  };

  const redeemOk = async (
    code: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<GuestRedeemSuccess> => {
    const result = await redeem(code, body, headers);
    if (result.response.status !== 200) {
      throw new Error(`expected redeem success, got ${result.response.status}`);
    }
    return result.payload as GuestRedeemSuccess;
  };

  const connect = async (token: string): Promise<WebSocket> => {
    const ws = new WebSocket(
      `${wsBase}/guest/ws?guest_token=${encodeURIComponent(token)}`,
      GUEST_WS_SUBPROTOCOL,
    );
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    await once(ws, "open");
    return ws;
  };

  const stop = async () => {
    for (const ws of sockets) {
      ws.terminate();
    }
    sockets.clear();
    controller.close();
    store.close();
    await closeServer(server);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  };

  return {
    stateDir,
    store,
    connections,
    controller,
    server,
    httpBase,
    wsBase,
    createGrant,
    redeem,
    redeemOk,
    connect,
    stop,
  };
}

export async function waitForGuestResponse(
  ws: WebSocket,
  id: string,
  frame: unknown,
): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (data: RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed.type === "res" && parsed.id === id) {
          ws.off("message", onMessage);
          resolve(parsed);
        }
      } catch (error) {
        reject(error);
      }
    };
    ws.on("message", onMessage);
  });
  ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  return await response;
}

export async function expectGuestUpgradeRejected(wsBase: string, token?: string): Promise<number> {
  const query = token === undefined ? "" : `?guest_token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(`${wsBase}/guest/ws${query}`, GUEST_WS_SUBPROTOCOL);
  return await new Promise<number>((resolve, reject) => {
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.once("open", () => reject(new Error("expected guest websocket upgrade rejection")));
    ws.once("error", () => undefined);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
