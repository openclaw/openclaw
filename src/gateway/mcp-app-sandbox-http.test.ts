import type { IncomingMessage } from "node:http";
import { runInNewContext, Script } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { listenLoopback } from "../../test/helpers/gateway-integration-fixtures.js";
import { buildMcpAppSandboxPath } from "../agents/mcp-app-sandbox.js";
import { SANDBOX_HOST_PATH } from "../agents/sandbox-host.js";
import {
  createSandboxHostHttpServer,
  createSandboxHostHttpRequestHandler,
} from "./mcp-app-sandbox-http.js";
import { makeMockHttpResponse } from "./test-http-response.js";

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

async function withSandboxHost(run: (origin: string) => Promise<void>) {
  await using server = createSandboxHostHttpServer();
  await run(await listenLoopback(server));
}

function bootSandbox(bootstrap: string, origin: string, parentOrigin = "https://control.example") {
  const posted: unknown[][] = [];
  const frames: { srcdoc: string }[] = [];
  const parent = { postMessage: (...args: unknown[]) => posted.push(args) };
  const location = { href: `${origin}/mcp-app-sandbox`, ancestorOrigins: [parentOrigin] };
  let receive: (event: unknown) => void = () => {};
  const window = {
    parent,
    location,
    top: {
      get document(): never {
        throw new Error("cross-origin");
      },
    },
    addEventListener: (_name: string, listener: typeof receive) => (receive = listener),
  };
  runInNewContext(bootstrap, {
    URL,
    window: Object.assign(window, { self: window }),
    location,
    document: {
      referrer: "",
      body: { appendChild: () => {} },
      createElement: () => {
        const frame = {
          srcdoc: "",
          setAttribute: () => {},
          addEventListener: () => {},
          replaceWith: () => {},
        };
        frames.push(frame);
        return frame;
      },
    },
  });
  return {
    posted,
    frames,
    receive: (data: unknown) => receive({ source: parent, origin: parentOrigin, data }),
  };
}

describe("MCP App sandbox HTTP origin", () => {
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

  it("boots without a referrer and serves executable widget bridges to its bound parent", async () => {
    await withSandboxHost(async (origin) => {
      const shell = await (await fetch(new URL(buildMcpAppSandboxPath(), origin))).text();
      const bootstrap = expectDefined(
        [...shell.matchAll(/<script>([\s\S]*?)<\/script>/gu)].at(-1)?.[1],
        "sandbox bootstrap script",
      );
      const { posted, frames, receive } = bootSandbox(bootstrap, origin);
      // WebKit navigates an already attached iframe without the referrer the host requested.
      expect(posted).toEqual([
        [
          expect.objectContaining({ method: "ui/notifications/sandbox-proxy-ready" }),
          "https://control.example",
        ],
      ]);
      expect(() => bootSandbox(bootstrap, origin, "null")).toThrow(
        "invalid MCP App sandbox parent",
      );
      receive({
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "<!doctype html><p>Synthetic widget</p>" },
      });
      const widget = expectDefined(frames.at(-1), "rendered widget frame").srcdoc;
      const scripts = [...widget.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
      expect(scripts.length).toBeGreaterThan(0);
      for (const [, source] of scripts) {
        expect(() => new Script(source!)).not.toThrow();
      }
    });
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

it("rejects a malformed resource request without an unhandled URL exception", async () => {
  const { res, end } = makeMockHttpResponse();
  const handler = createSandboxHostHttpRequestHandler({ clients: new Set() });
  await handler({ url: "http://[", method: "GET" } as IncomingMessage, res);
  expect(res.statusCode).toBe(400);
  expect(end).toHaveBeenCalledWith("Bad Request");
});
