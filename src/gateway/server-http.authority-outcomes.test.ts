import { once } from "node:events";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as lifecycle from "../infra/http-request-lifecycle.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  bindHttpResponseAuthority,
  captureHttpRequestAuthority,
} from "./http-request-authority.js";
import { GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE } from "./operator-access-policy.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";

const route = vi.fn<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>>();
const log = createSubsystemLogger("test/http-authority");
let listener: Awaited<ReturnType<typeof reserveTestPortListener>>;

beforeAll(async () => {
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    pluginId: "authority-fixture",
    source: "fixture",
    path: "/authority/plugin",
    match: "exact",
    auth: "plugin",
    handler: route,
  });
  listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createGatewayHttpServer({
        clients: new Set(),
        controlUiEnabled: false,
        controlUiBasePath: "",
        resolvedAuth: { mode: "none", allowTailscale: false },
        getRuntimeConfig: () => ({}),
        handleHooksRequest: (req, res) =>
          req.url === "/authority/core" ? route(req, res) : Promise.resolve(false),
        handlePluginRequest: createGatewayPluginRequestHandler({ registry, log }),
        shouldEnforcePluginGatewayAuth: () => false,
      }),
  });
});

afterEach(() => {
  route.mockReset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    await listener.releaseListener();
  } finally {
    await listener.claim.release();
  }
});

describe.each(["core", "plugin"])("Gateway HTTP %s authority outcomes", (surface) => {
  it.each([
    "disconnect",
    "client expired",
    "operator revoked",
    "stream client expired",
    "stream operator revoked",
    "unexpected",
  ])("owns %s after awaited request work", async (outcome) => {
    const entered = createDeferred<ServerResponse>();
    const release = createDeferred();
    const streaming = createDeferred();
    const operator = new AbortController();
    let auth: ResolvedGatewayAuth = { mode: "token", token: "before", allowTailscale: false };
    const unexpectedError = new Error("HTTP request authority expired");
    const unhandled = vi.spyOn(console, "error").mockImplementation(() => {});
    const warning = vi.spyOn(log, "warn").mockImplementation(() => {});
    const requests = vi.spyOn(lifecycle, "runHttpConnectionRequest");
    route.mockImplementation(async (req, res) => {
      const authority = bindHttpResponseAuthority(
        {
          operatorAccessAuthority: {
            signal: operator.signal,
            assertCurrent: () => operator.signal.throwIfAborted(),
          },
        },
        res,
        captureHttpRequestAuthority({
          req,
          auth,
          cfg: {},
          getRuntimeConfig: () => ({}),
          getResolvedAuth: () => auth,
        }),
      );
      authority.assertCurrent();
      if (outcome.startsWith("stream")) {
        res.write("partial");
      }
      entered.resolve(res);
      await release.promise;
      if (outcome === "unexpected") {
        throw unexpectedError;
      }
      authority.assertCurrent();
      res.end("must not disclose prepared data");
      return true;
    });
    const response = createDeferred<{ status?: number; body: string; aborted?: boolean }>();
    const client = request(
      {
        host: "127.0.0.1",
        port: listener.claim.port,
        path: `/authority/${surface}`,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          streaming.resolve();
        });
        res.once("end", () => response.resolve({ status: res.statusCode, body }));
        res.once("aborted", () =>
          response.resolve({ status: res.statusCode, body, aborted: true }),
        );
        res.once("error", (error) => {
          if (!outcome.startsWith("stream")) {
            response.reject(error);
          }
        });
      },
    );
    client.once("error", (error) => {
      if (outcome === "disconnect") {
        response.resolve({ body: "" });
      } else {
        response.reject(error);
      }
    });
    client.end();
    try {
      const res = await entered.promise;
      if (outcome.startsWith("stream")) {
        await streaming.promise;
      }
      if (outcome === "disconnect") {
        const closed = once(res, "close");
        client.destroy();
        await closed;
      } else if (outcome.endsWith("client expired")) {
        auth = { ...auth, token: "after" };
      } else if (outcome.endsWith("operator revoked")) {
        operator.abort();
      }
      const end = vi.spyOn(res, "end");
      const write = vi.spyOn(res, "write");
      const headers = vi.spyOn(res, "setHeader");
      const writeHead = vi.spyOn(res, "writeHead");
      release.resolve();
      await requests.mock.results[0]!.value;
      const received = await response.promise;
      expect(write).not.toHaveBeenCalled();
      const closed = outcome === "disconnect" || outcome.startsWith("stream");
      expect(end).toHaveBeenCalledTimes(closed ? 0 : 1);
      if (closed) {
        expect(headers).not.toHaveBeenCalled();
        expect(writeHead).not.toHaveBeenCalled();
      }
      if (outcome.startsWith("stream")) {
        expect(received).toEqual({ status: 200, body: "partial", aborted: true });
      } else if (outcome === "client expired") {
        expect(received).toEqual({
          status: 401,
          body: JSON.stringify({ error: { message: "Unauthorized", type: "unauthorized" } }),
        });
      } else if (outcome === "operator revoked") {
        expect(received).toEqual({
          status: 403,
          body: JSON.stringify({
            error: { message: GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE, type: "forbidden" },
          }),
        });
      } else if (outcome === "unexpected") {
        expect(received).toEqual({ status: 500, body: "Internal Server Error" });
      }
      if (outcome === "unexpected") {
        if (surface === "core") {
          expect(unhandled).toHaveBeenCalledExactlyOnceWith(
            "[gateway-http] unhandled error in request handler:",
            unexpectedError,
          );
        } else {
          expect(warning).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining("plugin http route failed"),
          );
        }
      } else {
        expect(unhandled).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      client.destroy();
      await Promise.all(requests.mock.results.map((result) => result.value));
    }
  });
});
