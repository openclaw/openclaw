import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { respondNotFound, respondPlainText } from "./control-ui-http-utils.js";
import { respondControlUiNotAcceptable } from "./control-ui-static.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import type { ControlUiRootState } from "./server-control-ui-root.js";

type ResponseCase = {
  body: string;
  path: string;
  root?: ControlUiRootState;
  headers?: Record<string, string>;
  statusCode?: number;
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/plain-not-found") {
      respondNotFound(res);
      return;
    }
    if (pathname === "/no-content") {
      respondPlainText(res, 204, "");
      return;
    }
    if (pathname === "/not-acceptable") {
      respondControlUiNotAcceptable(res);
      return;
    }

    const root = RESPONSE_CASES.find((entry) => entry.path === pathname)?.root;
    void handleControlUiHttpRequest(req, res, root ? { root } : undefined).catch(
      (error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      },
    );
  });
  baseUrl = await listenLoopback(server);
});

afterAll(() => closeHttpServer(server));

const RESPONSE_CASES: ResponseCase[] = [
  { path: "/plain-not-found", statusCode: 404, body: "Not Found" },
  { path: "/no-content", statusCode: 204, body: "" },
  {
    path: "/not-acceptable",
    statusCode: 406,
    body: "Not Acceptable",
    headers: { "cache-control": "no-store", vary: "Accept-Encoding" },
  },
  {
    path: "/root-invalid",
    root: { kind: "invalid", path: "/missing/界" },
    body: "Control UI assets not found at /missing/界. Build them with `pnpm ui:build` (auto-installs UI deps), or update gateway.controlUi.root.",
  },
  {
    path: "/root-preparing",
    root: { kind: "preparing" },
    body: "Control UI assets are being prepared. Try again shortly.",
    headers: { "cache-control": "no-store", "retry-after": "1" },
  },
  {
    path: "/root-failed",
    root: { kind: "failed" },
    body: "Control UI assets could not be prepared. Check the Gateway logs or run `openclaw doctor --fix`.",
  },
  {
    path: "/root-missing",
    root: { kind: "missing" },
    body: "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
  },
  {
    path: "/root-disappeared",
    root: { kind: "resolved", path: "/openclaw-test/missing-control-ui-root" },
    body: "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
  },
];

it.each(RESPONSE_CASES)(
  "preserves plain-text metadata and HEAD suppression for $path",
  async ({ path, statusCode = 503, body, headers }) => {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      expect(response.status).toBe(statusCode);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        Buffer.from(method === "GET" ? body : ""),
      );
      const expectedHeaders = {
        "content-type": "text/plain; charset=utf-8",
        "content-length": statusCode === 204 ? null : String(Buffer.byteLength(body)),
        ...(statusCode === 503 ? { "retry-after": null } : {}),
        ...headers,
      };
      for (const [name, value] of Object.entries(expectedHeaders)) {
        expect(response.headers.get(name)).toBe(value);
      }
    }
  },
);
