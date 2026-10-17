import { once } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildMcpAppSandboxPath } from "../agents/mcp-app-sandbox.js";
import { SANDBOX_HOST_PATH } from "../agents/sandbox-host.js";
import type { PluginBoardWidgetContentKind } from "../plugins/board-widget-content-kind.types.js";
import { createPluginBoardWidgetContentKindRegistrar } from "../plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../plugins/loader-records.js";
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

async function getAndHead(url: string | URL) {
  const get = await fetch(url);
  const head = await fetch(url, { method: "HEAD" });
  const body = await get.text();
  expect(head.status).toBe(get.status);
  expect(await head.text()).toBe("");
  expect(get.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  for (const header of [
    "content-type",
    "content-length",
    "cache-control",
    "content-security-policy",
    "permissions-policy",
    "cross-origin-resource-policy",
    "origin-agent-cluster",
    "referrer-policy",
    "x-content-type-options",
  ]) {
    expect(head.headers.get(header), header).toBe(get.headers.get(header));
  }
  return { get, body };
}

function request(url: string, method: "GET" | "HEAD" | "POST" = "GET") {
  const { res, end, setHeader } = makeMockHttpResponse();
  const server = createSandboxHostHttpServer();
  server.emit("request", { url, method } as IncomingMessage, res);
  server.removeAllListeners();
  return { res, end, setHeader };
}

async function withSandboxHost(
  run: (origin: string) => Promise<void>,
  registry?: PluginRegistry,
): Promise<void> {
  const server = createSandboxHostHttpServer(undefined, registry && (() => registry));
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function publicResourceRegistry(
  readPublicResource: PluginBoardWidgetContentKind["resources"]["readPublicResource"],
) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "renderer",
    source: "fixture",
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  createPluginBoardWidgetContentKindRegistrar(registry)(record, {
    kind: "diagram",
    label: "Diagram",
    resources: {
      surface: "renderer",
      paths: [RESOURCE_PATH],
      readPublicResource,
    },
    validateSource() {},
    composeDocument: () => "",
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
      buildMcpAppSandboxPath(),
      buildMcpAppSandboxPath({
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      }),
      buildMcpAppSandboxPath({ blockDescendantFrames: true }),
      buildMcpAppSandboxPath({ mediaDomains: ["https://media.example"] }),
      buildMcpAppSandboxPath({ frameDomains: ["https://frames.example"] }),
      buildMcpAppSandboxPath({ baseUriDomains: ["https://base.example"] }),
      originalPath,
      buildMcpAppSandboxPath(mutablePolicy),
    ] as const;
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
        url.searchParams.set("v", "stale-version");
        const stale = await fetch(url);
        expect(stale.headers.get("cache-control")).toBe("no-store");
        expect(await stale.text()).toBe(body);
        url.searchParams.delete("v");
        const unversioned = await fetch(url);
        expect(unversioned.headers.get("cache-control")).toBe("no-store");
        expect(await unversioned.text()).toBe(body);
      }
      expect(versions.size).toBe(paths.length);

      const altered = new URL(paths[1], origin);
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
    const registry = publicResourceRegistry(read);
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
        expect((await fetch(`${origin}${deniedPath}`)).status).toBe(404);
      }
      expect(read).toHaveBeenCalledTimes(2);
    }, registry);
  });

  it("does not expose registered assets without the public-reader opt-in", async () => {
    const registry = publicResourceRegistry(undefined);
    await withSandboxHost(async (origin) => {
      expect((await fetch(`${origin}${RESOURCE_PATH}`)).status).toBe(404);
    }, registry);
  });

  it("supports HEAD and rejects other paths, methods, and malformed policy", () => {
    const head = request(buildMcpAppSandboxPath(), "HEAD");
    expect(head.res.statusCode).toBe(200);
    expect(head.end).toHaveBeenCalledWith(undefined);

    expect(request("/", "GET").res.statusCode).toBe(404);
    expect(request(buildMcpAppSandboxPath(), "POST").res.statusCode).toBe(404);
    expect(request(`${SANDBOX_HOST_PATH}?csp=not-json`).res.statusCode).toBe(400);
    const jsonButNotCsp = Buffer.from("null", "utf8").toString("base64url");
    expect(request(`${SANDBOX_HOST_PATH}?csp=${jsonButNotCsp}`).res.statusCode).toBe(400);
    expect(request(`${SANDBOX_HOST_PATH}?csp=`).res.statusCode).toBe(400);
    expect(request("http://[", "GET").res.statusCode).toBe(400);
    const unsafeHeaderPolicy = Buffer.from(
      JSON.stringify({ connectDomains: ["https://api.\nexample.com"] }),
      "utf8",
    ).toString("base64url");
    expect(request(`${SANDBOX_HOST_PATH}?csp=${unsafeHeaderPolicy}`).res.statusCode).toBe(400);
  });

  it("keeps GET and HEAD representation metadata aligned for a missing path", async () => {
    await withSandboxHost(async (origin) => {
      const { get, body } = await getAndHead(`${origin}/missing`);
      expect(get.status).toBe(404);
      expect(body).not.toBe("");
    });
  });
});
