import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { respondNotFound, respondPlainText } from "./control-ui-http-utils.js";
import { respondControlUiNotAcceptable } from "./control-ui-static.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import type { ControlUiRootState } from "./server-control-ui-root.js";

type RootResponseCase = {
  body: string;
  path: string;
  root?: ControlUiRootState;
  headers?: Record<string, string>;
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

    const root = ROOT_RESPONSE_CASES.find((entry) => entry.path === pathname)?.root;
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

async function expectRepresentation(
  path: string,
  status: number,
  expected: { body: string; headers?: Record<string, string>; missingHeaders?: string[] },
) {
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    expect(response.status).toBe(status);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body).toEqual(Buffer.from(method === "GET" ? expected.body : ""));
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(expected.body)));
    for (const [name, value] of Object.entries(expected.headers ?? {})) {
      expect(response.headers.get(name)).toBe(value);
    }
    for (const name of expected.missingHeaders ?? []) {
      expect(response.headers.get(name)).toBeNull();
    }
  }
}

const ROOT_RESPONSE_CASES: RootResponseCase[] = [
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

describe("Control UI plain-text response metadata", () => {
  it("preserves byte length while Node suppresses the HEAD body", async () => {
    await expectRepresentation("/plain-not-found", 404, { body: "Not Found" });
  });

  it("keeps 406 cache negotiation headers on GET and HEAD", async () => {
    await expectRepresentation("/not-acceptable", 406, {
      body: "Not Acceptable",
      headers: { "cache-control": "no-store", vary: "Accept-Encoding" },
    });
  });

  it.each(ROOT_RESPONSE_CASES)(
    "keeps 503 metadata and HEAD suppression for $path",
    async ({ path, ...expected }) => {
      await expectRepresentation(path, 503, {
        ...expected,
        missingHeaders: expected.headers ? [] : ["retry-after"],
      });
    },
  );

  it("omits Content-Length and bodies for 204", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await fetch(`${baseUrl}/no-content`, { method });
      expect(response.status).toBe(204);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(response.headers.get("content-length")).toBeNull();
    }
  });
});
