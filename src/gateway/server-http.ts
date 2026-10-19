import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { runHttpConnectionRequest } from "../infra/http-request-lifecycle.js";
import { createGatewayHttpRequestHandler } from "./server-http-request.js";
import type { GatewayHttpRequestHandler, GatewayHttpServerOptions } from "./server-http.types.js";

const requestHandlers = new WeakMap<HttpServer, GatewayHttpRequestHandler>();

export function getGatewayHttpRequestHandler(server: HttpServer): GatewayHttpRequestHandler {
  const handler = requestHandlers.get(server);
  if (!handler) {
    throw new Error("Gateway HTTP owner is unavailable");
  }
  return handler;
}

export function createGatewayHttpServer(opts: GatewayHttpServerOptions): HttpServer {
  const handler = createGatewayHttpRequestHandler(opts);
  const server =
    opts.testListener ??
    (opts.tlsOptions ? createHttpsServer(opts.tlsOptions) : createHttpServer());
  requestHandlers.set(server, handler);
  server.on("request", (req, res) => void handler(req, res));
  server.once("close", () => handler.dispose());
  server.on("checkContinue", (req, res) => void handler(req, res, "continue"));
  server.on("checkExpectation", (req, res) => void handler(req, res, "reject"));
  server.on("connect", (req, socket) => {
    void runHttpConnectionRequest(
      req,
      async () => {
        socket.destroy();
      },
      "upgrade",
    );
  });
  return server;
}
