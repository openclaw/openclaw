// Gateway hook test fixtures.
// Builds resolved hook config and IncomingMessage-like requests for tests.
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { HooksConfigResolved } from "./hooks.js";

/** Creates the default resolved hook config used by gateway hook tests. */
export function createHooksConfig(): HooksConfigResolved {
  return {
    basePath: "/hooks",
    token: "hook-secret",
    maxBodyBytes: 1024,
    mappings: [],
    agentPolicy: {
      defaultAgentId: "main",
      knownAgentIds: new Set(["main"]),
      allowedAgentIds: undefined,
    },
    sessionPolicy: {
      allowRequestSessionKey: false,
      defaultSessionKey: undefined,
      allowedSessionKeyPrefixes: undefined,
    },
  };
}

/** Builds an IncomingMessage-shaped request for hook handler tests. */
export function createGatewayRequest(params: {
  path: string;
  authorization?: string;
  method?: string;
  remoteAddress?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: params.host ?? "localhost:18789",
    ...params.headers,
  };
  if (params.authorization) {
    headers.authorization = params.authorization;
  }
  if (params.body !== undefined) {
    headers["content-length"] ??= String(Buffer.byteLength(params.body, "utf8"));
    headers["content-type"] ??= "application/json";
  }
  const body = params.body;
  let bodyScheduled = false;
  const emitter = new EventEmitter();
  const request = Object.assign(emitter, {
    method: params.method ?? "GET",
    url: params.path,
    headers,
    socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
    destroyed: false,
  }) as IncomingMessage & { destroyed: boolean };
  request.destroy = () => {
    request.destroyed = true;
    emitter.emit("close");
    return request;
  };
  if (body !== undefined) {
    const scheduleBody = () => {
      if (bodyScheduled) {
        return;
      }
      bodyScheduled = true;
      setImmediate(() => {
        if (request.destroyed) {
          return;
        }
        request.emit("data", Buffer.from(body, "utf8"));
        request.emit("end");
      });
    };
    request.on("newListener", (eventName) => {
      if (eventName === "data" || eventName === "end") {
        scheduleBody();
      }
    });
  }
  return request;
}
