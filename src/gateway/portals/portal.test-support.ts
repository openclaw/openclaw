import {
  createServer,
  request,
  type RequestListener,
  type RequestOptions,
  type Server,
} from "node:http";
import { request as requestHttps } from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as httpListen from "../server/http-listen.js";
import { createGatewayPortalService, type GatewayPortalService } from "./portal-service.js";

export function usePortalHarness() {
  const services: GatewayPortalService[] = [];
  const temporary: Server[] = [];
  const target: { port: number; handler: RequestListener; server: Server } = {
    port: 0,
    handler: (_req, res) => res.end("target"),
    server: createServer((req, res) => target.handler(req, res)),
  };
  const sockets = new Set<import("node:net").Socket>();
  target.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  async function listen(server: Server) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing test listener");
    }
    return address.port;
  }
  async function close(server: Server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  beforeAll(async () => {
    target.port = await listen(target.server);
  });
  beforeEach(() => {
    target.handler = (_req, res) => res.end("target");
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.closeAll()));
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(temporary.splice(0).map(close));
  });
  afterAll(() => close(target.server));
  return {
    target,
    makeService: (options: Partial<Parameters<typeof createGatewayPortalService>[0]> = {}) => {
      const httpServers = options.httpServers ?? [];
      const service = createGatewayPortalService({
        httpBindHosts: ["127.0.0.1"],
        httpServers,
        ...options,
      });
      services.push(service);
      return { service, httpServers };
    },
    listenTarget: async (handler: RequestListener) => {
      const server = createServer(handler);
      temporary.push(server);
      return listen(server);
    },
  };
}

export async function requestText(url: string | URL, options: RequestOptions = {}, body?: string) {
  const requestFn = new URL(url).protocol === "https:" ? requestHttps : request;
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = requestFn(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.once("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

export function holdPortalBind() {
  const started = createDeferred();
  const released = createDeferred();
  const listen = httpListen.listenGatewayHttpServer;
  vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
    started.resolve();
    await released.promise;
    await listen(params);
  });
  return { started: started.promise, release: released.resolve };
}

export function authority(message: string) {
  const state = {
    current: true,
    assertCurrent: () => {
      if (!state.current) {
        throw new Error(message);
      }
    },
  };
  return state;
}
