import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForConfirmModal,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const basePath = "/control";
const forwardedHeaderBlocklist = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);
const expectedAssets = [
  { file: "favicon.svg", mime: "image/svg+xml", rel: "icon", type: "image/svg+xml" },
  { file: "favicon-32.png", mime: "image/png", rel: "icon", type: "image/png" },
  { file: "apple-touch-icon.png", mime: "image/png", rel: "apple-touch-icon" },
  { file: "manifest.webmanifest", mime: "application/manifest+json", rel: "manifest" },
];
const publicAssetPaths = new Set(expectedAssets.map(({ file }) => `/${file}`));

let proxy: Awaited<ReturnType<typeof startBasePathProxy>>;
const suite = createControlUiE2eSuite({
  name: "Control UI shell routing E2E",
  startServerBeforeBrowser: true,
  startServer: async () => {
    const server = await startControlUiE2eServer(undefined, { source: true });
    proxy = await startBasePathProxy(server.baseUrl);
    return {
      ...server,
      close: async () => {
        try {
          await proxy.close();
        } finally {
          await server.close();
        }
      },
    };
  },
});

async function startBasePathProxy(upstreamBaseUrl: string) {
  const requests: string[] = [];
  const proxyServer = createServer((request, response) => {
    void (async () => {
      const incomingUrl = new URL(request.url ?? "/", "http://control-ui.invalid");
      requests.push(incomingUrl.pathname);
      const hasBasePath = incomingUrl.pathname.startsWith(`${basePath}/`);
      if (!hasBasePath && publicAssetPaths.has(incomingUrl.pathname)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Public assets require the configured Control UI base path");
        return;
      }
      const upstreamPath = hasBasePath
        ? incomingUrl.pathname.slice(basePath.length)
        : incomingUrl.pathname;
      const upstreamUrl = new URL(`${upstreamPath}${incomingUrl.search}`, upstreamBaseUrl);
      const upstream = await fetch(upstreamUrl, {
        headers: { Accept: request.headers.accept ?? "*/*" },
        method: request.method,
        // Let Chromium observe redirects so the proxy cannot hide a root-mount regression.
        redirect: "manual",
      });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!forwardedHeaderBlocklist.has(name)) {
          response.setHeader(name, value);
        }
      }
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      let body = Buffer.from(await upstream.arrayBuffer());
      if (
        incomingUrl.pathname.startsWith(`${basePath}/`) &&
        upstream.headers.get("content-type")?.startsWith("text/html")
      ) {
        body = Buffer.from(
          body
            .toString("utf8")
            .replace("<html", `<html data-openclaw-control-ui-base-path="${basePath}"`),
        );
      }
      response.end(body);
    })().catch((error: unknown) => {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  proxyServer.listen(0, "127.0.0.1");
  await once(proxyServer, "listening");
  const address = proxyServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI base-path proxy did not expose a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: promisify(proxyServer.close.bind(proxyServer)),
    requests,
  };
}

suite.define(() => {
  it("opens a base-path route and connects to the confirmed alternate Gateway URL", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: { dir: suite.artifactDir, size: { height: 720, width: 1280 } },
        serviceWorkers: "block",
        viewport: { height: 720, width: 1280 },
      },
      async ({ page }) => {
        const explicitGatewayUrl = "ws://127.0.0.1:29991/alternate";
        // The Gateway cannot load its roster until this flow confirms the new URL.
        const gateway = await installMockGateway(page, { basePath, awaitInitialRoster: false });

        const url = new URL(`${basePath}/chat`, proxy.baseUrl);
        url.hash = new URLSearchParams({ gatewayUrl: explicitGatewayUrl }).toString();
        const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
        expect(response?.status()).toBe(200);

        const confirmation = page.locator("openclaw-gateway-url-confirmation");
        await waitForConfirmModal(page, confirmation.locator("openclaw-modal-dialog"));
        await confirmation.getByText(explicitGatewayUrl, { exact: true }).waitFor();
        expect(await confirmation.getByText(explicitGatewayUrl, { exact: true }).count()).toBe(1);
        await confirmation
          .getByRole("button", { name: "Switch to 127.0.0.1:29991", exact: true })
          .click();

        await gateway.waitForRequest("connect");
        await page.locator("openclaw-app-shell").waitFor();
        await page.locator("openclaw-chat-page").waitFor();

        expect(new URL(page.url()).pathname).toBe(`${basePath}/chat/main`);
        expect(new URL(page.url()).hash).toBe("");
        expect((await gateway.getSocketUrls()).at(-1)).toBe(explicitGatewayUrl);
        expect(await page.locator("html").getAttribute("data-openclaw-control-ui-base-path")).toBe(
          basePath,
        );

        // The proxy rejects root asset fallbacks. Assert the rewritten DOM and
        // request paths so only main.ts can make these links load under the base path.
        const assetResults = await page.evaluate(async () =>
          Promise.all(
            [
              ...document.querySelectorAll<HTMLLinkElement>(
                'link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]',
              ),
            ].map(async (link) => {
              const assetResponse = await fetch(link.href, { credentials: "include" });
              return {
                contentType: assetResponse.headers.get("content-type") ?? "",
                pathname: new URL(link.href).pathname,
                rel: link.rel,
                status: assetResponse.status,
                type: link.type,
              };
            }),
          ),
        );
        expect(assetResults).toEqual(
          expect.arrayContaining(
            expectedAssets.map(({ file, mime, ...link }) =>
              expect.objectContaining({
                ...link,
                pathname: `${basePath}/${file}`,
                status: 200,
                contentType: expect.stringContaining(mime),
              }),
            ),
          ),
        );
        expect(proxy.requests).toEqual(
          expect.arrayContaining([
            `${basePath}/chat`,
            ...expectedAssets.map(({ file }) => `${basePath}/${file}`),
          ]),
        );
        const unprefixedPublicAssetRequests = proxy.requests.filter((requestPath) =>
          publicAssetPaths.has(requestPath),
        );
        expect(unprefixedPublicAssetRequests).toEqual([]);

        await writeFile(
          path.join(suite.artifactDir, "connected-shell.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page.locator(".chat-main"),
          ]),
        );
      },
    );
  });
});
