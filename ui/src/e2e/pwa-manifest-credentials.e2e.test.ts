import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireString,
} from "./chat-flow.test-support.ts";

const httpCredentials = { username: "pwa-user", password: "pwa-password" };
const unforwardedHeaders = new Set([
  "cache-control",
  "connection",
  "content-encoding",
  "content-length",
]);

async function startAuthenticatedProxy(upstreamBaseUrl: string) {
  const manifestRequests: Array<{ authorized: boolean; status: 200 | 401 }> = [];
  const expectedAuthorization = `Basic ${Buffer.from(
    `${httpCredentials.username}:${httpCredentials.password}`,
  ).toString("base64")}`;

  const server = createServer((request, response) => {
    void forward(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { "Cache-Control": "no-store" });
      }
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP Basic Auth proof proxy did not expose a loopback port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    manifestRequests,
  };
  async function forward(request: IncomingMessage, response: ServerResponse) {
    const requestUrl = new URL(request.url ?? "/", upstreamBaseUrl);
    const authorized = request.headers.authorization === expectedAuthorization;
    if (requestUrl.pathname === "/manifest.webmanifest") {
      manifestRequests.push({ authorized, status: authorized ? 200 : 401 });
    }
    response.setHeader("Cache-Control", "no-store");
    if (!authorized) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="OpenClaw PWA E2E"' });
      response.end("HTTP Basic authentication required");
      return;
    }
    const upstream = await fetch(requestUrl, {
      headers: { Accept: request.headers.accept ?? "*/*" },
      method: request.method,
    });
    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers) {
      if (!unforwardedHeaders.has(name)) {
        response.setHeader(name, value);
      }
    }
    response.end(request.method === "HEAD" ? undefined : Buffer.from(await upstream.arrayBuffer()));
  }
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("loads the installable same-origin PWA manifest through an HTTP Basic Auth proxy", async () => {
    const proxy = await startAuthenticatedProxy(suite.server.baseUrl);
    const context = await suite.newBrowserContext({
      httpCredentials: { ...httpCredentials, origin: new URL(proxy.baseUrl).origin },
      serviceWorkers: "block",
    });

    try {
      const unauthenticated = await fetch(new URL("manifest.webmanifest", proxy.baseUrl));
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("www-authenticate")).toContain("Basic");
      proxy.manifestRequests.length = 0;

      const page = await context.newPage();
      await installMockGateway(page);
      const response = await page.goto(proxy.baseUrl, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);

      // CDP uses Chromium's PWA manifest loader; page.fetch cannot prove link credentials.
      const session = await context.newCDPSession(page);
      const manifest = await session.send("Page.getAppManifest");
      const buildId = requireString(
        await page.locator("html").getAttribute("data-openclaw-control-ui-build-id"),
        "bundled public asset build id",
      );
      const manifestUrl = new URL("manifest.webmanifest", proxy.baseUrl);
      manifestUrl.searchParams.set("v", buildId);

      expect(proxy.manifestRequests.length).toBeGreaterThan(0);
      expect(proxy.manifestRequests.filter((request) => !request.authorized)).toEqual([]);
      expect(manifest).toMatchObject({ url: manifestUrl.href, errors: [] });
      expect(JSON.parse(manifest.data ?? "null")).toMatchObject({
        display: "standalone",
        name: "OpenClaw Control",
      });
    } finally {
      await suite.closeBrowserContext(context);
      await proxy.close();
    }
  });
});
