import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { listenLoopback } from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildMcpAppSandboxPath } from "../agents/mcp-app-sandbox.js";
import { SANDBOX_HOST_PATH } from "../agents/sandbox-host.js";
import type { PluginBoardWidgetContentKind } from "../plugins/board-widget-content-kind.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import {
  createSandboxHostHttpServer,
  createSandboxHostHttpRequestHandler,
} from "./mcp-app-sandbox-http.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const RESOURCE_PATH = "/__openclaw__/renderer/app.js";
const javascript = (body: string) => ({
  body: Buffer.from(body),
  contentType: "application/javascript",
});

const representationHeaders = (response: Response) =>
  Object.fromEntries(
    [...response.headers].filter(([name]) => !["date", "connection", "keep-alive"].includes(name)),
  );

async function getAndHead(url: string | URL) {
  const get = await fetch(url);
  const head = await fetch(url, { method: "HEAD" });
  const body = await get.text();
  expect(head.status).toBe(get.status);
  expect(await head.text()).toBe("");
  expect(get.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  expect(representationHeaders(head)).toEqual(representationHeaders(get));
  return { get, body };
}

function request(url: string, method: "GET" | "HEAD" | "POST" = "GET") {
  const { res, end } = makeMockHttpResponse();
  const server = createSandboxHostHttpServer();
  server.emit("request", { url, method } as IncomingMessage, res);
  server.removeAllListeners();
  return { res, end };
}

async function withSandboxHost(run: (origin: string) => Promise<void>, registry?: PluginRegistry) {
  await using server = createSandboxHostHttpServer(undefined, registry && (() => registry));
  await run(await listenLoopback(server));
}

function publicResourceRegistry(
  readPublicResource: PluginBoardWidgetContentKind["resources"]["readPublicResource"],
) {
  const registry = createEmptyPluginRegistry();
  registry.boardWidgetContentKinds.set("diagram", {
    pluginId: "renderer",
    pluginKind: "renderer:diagram",
    definition: {
      kind: "diagram",
      label: "Diagram",
      resources: { surface: "renderer", paths: [RESOURCE_PATH], readPublicResource },
      validateSource() {},
      composeDocument: () => "",
    },
  });
  return registry;
}

describe("MCP App sandbox HTTP origin", () => {
  it("fences an awaited public renderer resource when the remote grant closes", async () => {
    const started = createDeferred();
    const resource = createDeferred<{ body: Uint8Array; contentType: string }>();
    const registry = publicResourceRegistry(async () => {
      started.resolve();
      return await resource.promise;
    });
    const controller = new AbortController();
    const req = new IncomingMessage(new Socket());
    req.method = "GET";
    req.url = RESOURCE_PATH;
    markGatewayIngressTransport(req, {
      kind: "remote-forwarded",
      context: createRemoteControlUiIngressTestContext({
        operatorScopeCeiling: ["operator.read"],
        frameAncestors: [],
        assertCurrent: () => controller.signal.throwIfAborted(),
      }),
    });
    const res = new ServerResponse(req);
    const serve = createSandboxHostHttpRequestHandler(() => registry)(req, res);
    await started.promise;
    controller.abort();
    resource.resolve(javascript("private-after-close"));
    await serve;
    expect(res).toMatchObject({ destroyed: true, writableEnded: false });
    req.destroy();
  });

  it("caches only the exact versioned public shell and separates effective policies", async () => {
    const mutablePolicy = { connectDomains: ["https://original.example"] };
    const originalPath = buildMcpAppSandboxPath(mutablePolicy);
    mutablePolicy.connectDomains[0] = "https://replacement.example";
    const paths = [
      undefined,
      {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      },
      { blockDescendantFrames: true },
      { mediaDomains: ["https://media.example"] },
      { frameDomains: ["https://frames.example"] },
      { baseUriDomains: ["https://base.example"] },
      mutablePolicy,
    ].map(buildMcpAppSandboxPath);
    paths.push(originalPath);
    await withSandboxHost(async (origin) => {
      const versions = new Set<string>();
      for (const path of paths) {
        const url = new URL(path, origin);
        const version = url.searchParams.get("v");
        expect(version).toMatch(/^[a-f0-9]{64}$/);
        versions.add(version!);
        const { get, body } = await getAndHead(url);
        expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(get.headers.get("set-cookie")).toBeNull();
        if (path === paths[1]) {
          const csp = get.headers.get("content-security-policy");
          expect(csp).toContain("connect-src https://api.example.com");
          expect(csp).toContain("webrtc 'block'");
          expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
          expect(csp).toContain("font-src 'self' https://cdn.example.com");
          expect(csp).toContain("frame-ancestors");
          expect(csp).toContain("frame-src 'none'");
          expect(get.headers.get("x-frame-options")).toBeNull();
          expect(get.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
          expect(get.headers.get("permissions-policy")).toBe(
            "camera=(), microphone=(), geolocation=(), clipboard-write=()",
          );
          expect(body).not.toContain("allow-popups");
        }
        for (const invalidateVersion of [
          () => url.searchParams.set("v", "stale-version"),
          () => url.searchParams.delete("v"),
        ]) {
          invalidateVersion();
          const uncached = await fetch(url);
          expect(uncached.headers.get("cache-control")).toBe("no-store");
          expect(await uncached.text()).toBe(body);
        }
      }
      expect(versions.size).toBe(paths.length);

      const altered = new URL(expectDefined(paths[1], "sandbox policy path"), origin);
      altered.searchParams.delete("csp");
      const response = await fetch(altered);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
      await response.text();
      expect(buildMcpAppSandboxPath({ connectDomains: ["invalid"] })).toBe(paths[0]);
    });
  });

  it("serves only explicitly public registered assets without Gateway credentials", async () => {
    const read = vi.fn(async () => javascript("window.rendererReady=true"));
    await withSandboxHost(async (origin) => {
      const url = `${origin}${RESOURCE_PATH}`;
      const { get, body } = await getAndHead(url);
      expect(get.status).toBe(200);
      expect(body).toBe("window.rendererReady=true");
      expect(get.headers.get("set-cookie")).toBeNull();
      expect(read).toHaveBeenCalledWith(RESOURCE_PATH);
      expect((await fetch(url, { method: "POST" })).status).toBe(404);
      for (const deniedPath of [
        "/",
        "/__openclaw__/renderer/private.js",
        "/__openclaw__/canvas/documents/private/index.html",
      ]) {
        const { get: denied, body: denial } = await getAndHead(`${origin}${deniedPath}`);
        expect(denied.status).toBe(404);
        expect(denial).not.toBe("");
      }
      expect(read).toHaveBeenCalledTimes(2);
    }, publicResourceRegistry(read));
  });

  it("does not expose registered assets without the public-reader opt-in", async () => {
    await withSandboxHost(async (origin) => {
      expect((await fetch(`${origin}${RESOURCE_PATH}`)).status).toBe(404);
    }, publicResourceRegistry(undefined));
  });

  it("rejects other paths, methods, and malformed policy", () => {
    expect(request("/", "GET").res.statusCode).toBe(404);
    expect(request(buildMcpAppSandboxPath(), "POST").res.statusCode).toBe(404);
    const encode = (policy: unknown) => Buffer.from(JSON.stringify(policy)).toString("base64url");
    for (const policy of [
      "not-json",
      encode(null),
      "",
      encode({ connectDomains: ["https://api.\nexample.com"] }),
    ]) {
      expect(request(`${SANDBOX_HOST_PATH}?csp=${policy}`).res.statusCode).toBe(400);
    }
    expect(request("http://[", "GET").res.statusCode).toBe(400);
  });
});
