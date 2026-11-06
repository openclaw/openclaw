import http, { type RequestOptions } from "node:http";
import { request as requestHttps } from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  listenLoopback,
  readRequestText,
} from "../../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as httpListen from "../server/http-listen.js";
import { createGatewayPortalService, type GatewayPortalService } from "./portal-service.js";

export function usePortalHarness() {
  const services: GatewayPortalService[] = [];
  const temporary: http.Server[] = [];
  const target: { port: number; handler: http.RequestListener; server: http.Server } = {
    port: 0,
    handler: (_req, res) => res.end("target"),
    server: http.createServer((req, res) => target.handler(req, res)),
  };
  const sockets = new Set<import("node:net").Socket>();
  target.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const listen = async (server: http.Server) => Number(new URL(await listenLoopback(server)).port);
  function close(server: http.Server) {
    const closed = server[Symbol.asyncDispose]();
    server.closeAllConnections();
    return closed;
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
    listenTarget: async (handler: http.RequestListener) => {
      const server = http.createServer(handler);
      temporary.push(server);
      return listen(server);
    },
  };
}

export async function requestText(url: string | URL, options: RequestOptions = {}, body?: string) {
  const requestFn = new URL(url).protocol === "https:" ? requestHttps : http.request;
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    requestFn(url, options, resolve).once("error", reject).end(body);
  });
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: await readRequestText(response),
  };
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
