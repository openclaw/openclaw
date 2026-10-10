import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { serveControlUiIndexHtml } from "../../../src/gateway/control-ui-index.js";
import { normalizeControlUiRemoteImageOrigins } from "../../../src/gateway/control-ui-remote-images.js";
import { createApplicationConfigCapability } from "../app/config.ts";
import { registerControlUiReloadGuard } from "../app/document-reload-guard.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("remote image browser requests", () => {
  it("admits exact HTTPS origins and revokes them when a guarded reload is blocked", async () => {
    const renderMessage = (origins: readonly string[], phase: string) =>
      toSanitizedMarkdownHtml(
        [
          "![Allowed](https://images.example.test/document.png?case=" + phase + ")",
          "![Unconfigured](https://denied.example.test/document.png?case=" + phase + ")",
          "![HTTP counterpart](http://images.example.test/document.png?case=" + phase + ")",
          "![Wrong port](https://images.example.test:8443/document.png?case=" + phase + ")",
        ].join("\n\n"),
        { remoteImages: true, remoteImageOrigins: [...origins] },
      );

    const emptyMessage = renderMessage([], "empty");
    const allowedMessage = renderMessage(["https://images.example.test"], "bootstrap-grant");
    const invalidHttpMessage = renderMessage(
      ["http://images.example.test"],
      "http-scheme-counterpart",
    );
    const beforeRevocationMessage = renderMessage(
      ["https://images.example.test"],
      "before-revocation",
    );
    const revokedMessage = renderMessage([], "guarded-revocation");
    expect(normalizeControlUiRemoteImageOrigins(["http://images.example.test"])).toEqual([]);

    const documentHtml =
      "<!doctype html><html><head></head><body>" + emptyMessage + "</body></html>";
    const server = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/") {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
      void serveControlUiIndexHtml(req, res, documentHtml, "/", undefined, true).catch(
        (error: unknown) => {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        },
      );
    });

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let unregisterReloadGuard: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Control UI test server did not bind to a TCP port");
      }
      const controlUiOrigin = "http://127.0.0.1:" + (address as AddressInfo).port;

      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const requests: string[] = [];
      let mainFrameNavigations = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          mainFrameNavigations++;
        }
      });
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.startsWith(controlUiOrigin + "/")) {
          await route.continue();
          return;
        }
        requests.push(url);
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        });
      });

      const response = await page.goto(controlUiOrigin + "/");
      await page.waitForFunction(() => [...document.images].every((image) => image.complete));
      const csp = response?.headers()["content-security-policy"];
      const cspImgSrc = csp?.split("; ").find((directive) => directive.startsWith("img-src "));
      expect(cspImgSrc).toBe("img-src 'self' data: blob: https:");
      expect(requests).toEqual([]);
      const pageUrl = page.url();

      const reload = vi.fn();
      vi.stubGlobal("window", { location: { origin: controlUiOrigin, reload } });
      vi.stubGlobal("document", {
        documentElement: {
          getAttribute: (name: string) =>
            name === CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE ? "true" : null,
          hasAttribute: () => false,
          style: { getPropertyValue: () => "", removeProperty: vi.fn(), setProperty: vi.fn() },
        },
      });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              basePath: "",
              assistantName: "Assistant",
              assistantAvatar: "A",
              serverVersion: "test",
              terminalEnabled: true,
              remoteImageOrigins: ["https://images.example.test"],
              pluginFrameGrants: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              basePath: "",
              assistantName: "Assistant",
              assistantAvatar: "A",
              serverVersion: "test",
              terminalEnabled: false,
              remoteImageOrigins: [],
              pluginFrameGrants: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      unregisterReloadGuard = registerControlUiReloadGuard(() => false, vi.fn());

      const pendingRenders: Promise<void>[] = [];
      const config = createApplicationConfigCapability({ resourceBasePath: "" });
      config.subscribe((next) => {
        const body = next.remoteImageOrigins.length > 0 ? allowedMessage : revokedMessage;
        pendingRenders.push(
          page.evaluate((html) => {
            document.body.innerHTML = html;
          }, body),
        );
      });
      const flushRenders = async () => {
        await Promise.all(pendingRenders.splice(0));
        await page.waitForFunction(() => [...document.images].every((image) => image.complete));
      };

      expect(await config.refresh()).toMatchObject({
        remoteImageOrigins: ["https://images.example.test"],
      });
      await flushRenders();
      const afterBootstrapGrant = requests.toSorted();
      expect(afterBootstrapGrant).toEqual([
        "https://images.example.test/document.png?case=bootstrap-grant",
      ]);

      requests.length = 0;
      await page.evaluate((html) => {
        document.body.innerHTML = html;
      }, invalidHttpMessage);
      await page.waitForFunction(() => [...document.images].every((image) => image.complete));
      const afterHttpSchemeCounterpart = requests.toSorted();
      expect(afterHttpSchemeCounterpart).toEqual([]);

      requests.length = 0;
      await page.evaluate((html) => {
        document.body.innerHTML = html;
      }, beforeRevocationMessage);
      await page.waitForFunction(() => [...document.images].every((image) => image.complete));
      expect(requests.toSorted()).toEqual([
        "https://images.example.test/document.png?case=before-revocation",
      ]);

      requests.length = 0;
      await config.refresh();
      await flushRenders();
      const afterGuardedRevocation = requests.toSorted();
      expect(afterGuardedRevocation).toEqual([]);
      expect(config.current.remoteImageOrigins).toEqual([]);
      expect(config.current.terminalEnabled).toBe(true);
      expect(reload).not.toHaveBeenCalled();
      expect(page.url()).toBe(pageUrl);
      expect(mainFrameNavigations).toBe(1);

      console.info(
        "[remote-image-browser-proof] " +
          JSON.stringify({
            cspImgSrc,
            defaultPolicyRequests: [],
            candidatesDuringExactHttpsGrant: [
              "https://images.example.test/document.png?case=bootstrap-grant",
              "https://denied.example.test/document.png?case=bootstrap-grant",
              "http://images.example.test/document.png?case=bootstrap-grant",
              "https://images.example.test:8443/document.png?case=bootstrap-grant",
            ],
            afterBootstrapGrant,
            afterHttpSchemeCounterpart,
            afterGuardedRevocation,
            guardedReloadBlocked: !reload.mock.calls.length && config.current.terminalEnabled,
            finalRemoteImageOrigins: config.current.remoteImageOrigins,
            mainFrameNavigations,
          }),
      );
    } finally {
      unregisterReloadGuard?.();
      vi.unstubAllGlobals();
      await browser?.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });
});
