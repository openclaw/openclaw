import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { buildMcpAppSandboxPath } from "../agents/mcp-app-sandbox.js";
import { injectSandboxDocumentGuard } from "../agents/sandbox-host.js";
import { createMcpAppSandboxHttpServer } from "./mcp-app-sandbox-http.js";
import { makeMockHttpResponse } from "./test-http-response.js";

function request(url: string, method: "GET" | "HEAD" | "POST" = "GET") {
  const { res, end, setHeader } = makeMockHttpResponse();
  const server = createMcpAppSandboxHttpServer();
  server.emit("request", { url, method } as IncomingMessage, res);
  server.removeAllListeners();
  return { res, end, setHeader };
}

describe("MCP App sandbox HTTP origin", () => {
  it("serves only the proxy endpoint with metadata-derived CSP", () => {
    const result = request(
      buildMcpAppSandboxPath({
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      }),
    );

    expect(result.res.statusCode).toBe(200);
    const csp = result.setHeader.mock.calls.findLast(
      (call) => call[0] === "Content-Security-Policy",
    )?.[1];
    expect(String(csp)).toContain("connect-src https://api.example.com");
    expect(String(csp)).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(String(csp)).toContain("font-src 'self' https://cdn.example.com");
    expect(String(csp)).toContain("frame-ancestors");
    expect(String(csp)).toContain("frame-src 'none'");
    expect(result.setHeader).not.toHaveBeenCalledWith("X-Frame-Options", expect.anything());
    expect(result.setHeader).toHaveBeenCalledWith("Cross-Origin-Resource-Policy", "cross-origin");
    expect(result.setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), clipboard-write=()",
    );
    expect(result.end).toHaveBeenCalledWith(expect.stringContaining("document.referrer"));
    expect(result.end).toHaveBeenCalledWith(expect.stringContaining("sandbox-proxy-ready"));
    expect(result.end).toHaveBeenCalledWith(expect.stringContaining("allow-scripts allow-forms"));
    expect(result.end).toHaveBeenCalledWith(
      expect.stringContaining("openclaw:widget-bridge-port-offer"),
    );
    expect(result.end).toHaveBeenCalledWith(expect.stringContaining("widgetBridgePortOffered"));
    const proxyHtml = String(result.end.mock.calls.at(-1)?.[0]);
    expect(proxyHtml).toContain("RTCPeerConnection");
    expect(proxyHtml).toContain("sandbox WebRTC isolation failed");
    expect(proxyHtml).toContain("nextInner.srcdoc = guardDocument(params.html)");
  });

  it("injects the network guard after a leading doctype and before executable content", () => {
    const guarded = injectSandboxDocumentGuard(
      `\uFEFF \n<!-- retained --><!DOCTYPE html PUBLIC "quoted > marker"><html><script>untrusted()</script>`,
    );

    expect(guarded).toMatch(
      /^\uFEFF \n<!-- retained --><!DOCTYPE html PUBLIC "quoted > marker"><script>/u,
    );
    expect(guarded.indexOf("sandbox WebRTC isolation failed")).toBeLessThan(
      guarded.indexOf("untrusted()"),
    );
    const withoutDoctype = injectSandboxDocumentGuard("<script>untrusted()</script>");
    expect(withoutDoctype).toMatch(/^<script>/u);
    expect(withoutDoctype.indexOf("WebRTC isolation")).toBeLessThan(
      withoutDoctype.indexOf("untrusted"),
    );
  });

  it("supports HEAD and rejects other paths, methods, and malformed policy", () => {
    const head = request(buildMcpAppSandboxPath(), "HEAD");
    expect(head.res.statusCode).toBe(200);
    expect(head.end).toHaveBeenCalledWith(undefined);

    expect(request("/", "GET").res.statusCode).toBe(404);
    expect(request(buildMcpAppSandboxPath(), "POST").res.statusCode).toBe(404);
    expect(request(`${buildMcpAppSandboxPath()}?csp=not-json`).res.statusCode).toBe(400);
    const jsonButNotCsp = Buffer.from("null", "utf8").toString("base64url");
    expect(request(`${buildMcpAppSandboxPath()}?csp=${jsonButNotCsp}`).res.statusCode).toBe(400);
    expect(request(`${buildMcpAppSandboxPath()}?csp=`).res.statusCode).toBe(400);
    expect(request("http://[", "GET").res.statusCode).toBe(400);
    const unsafeHeaderPolicy = Buffer.from(
      JSON.stringify({ connectDomains: ["https://api.\nexample.com"] }),
      "utf8",
    ).toString("base64url");
    expect(request(`${buildMcpAppSandboxPath()}?csp=${unsafeHeaderPolicy}`).res.statusCode).toBe(
      400,
    );
  });

  it("emits canonical ASCII origins for validated CSP domains", () => {
    const result = request(
      buildMcpAppSandboxPath({ connectDomains: ["https://b\u00fccher.example"] }),
    );

    expect(result.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("connect-src https://xn--bcher-kva.example"),
    );
  });
});
