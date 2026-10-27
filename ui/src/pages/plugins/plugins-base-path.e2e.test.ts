import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  startControlUiE2eServer,
  type MockGatewayWindow,
} from "../../test-helpers/control-ui-e2e.ts";
import { pluginMethodResponses, pluginMethods } from "./plugins.e2e.test-support.ts";
const basePath = "/ui";
const suite = createControlUiE2eSuite({
  name: "Mounted catalog startup",
  startServer: async () => {
    const source = await startControlUiE2eServer(undefined, { source: true });
    const proxy = createServer((request, response) => {
      void (async () => {
        const url = request.url ?? "/";
        const pathname = url.startsWith(basePath + "/") ? url.slice(basePath.length) : url;
        const upstream = await fetch(new URL(pathname, source.baseUrl));
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      })().catch((error: unknown) => {
        response.writeHead(502);
        response.end(String(error));
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Proxy port unavailable");
    }
    return {
      baseUrl: "http://127.0.0.1:" + address.port + "/",
      close: async () => {
        await promisify(proxy.close.bind(proxy))();
        await source.close();
      },
    };
  },
});
suite.define(() => {
  it("keeps a catalog detail on reload without an injected mount path", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        await page.addInitScript(createControlUiMockSameOriginGatewayScript());
        await installMockGateway(page, {
          basePath,
          featureMethods: pluginMethods,
          methodResponses: pluginMethodResponses(),
        });
        await page.addInitScript(() => {
          // Init-script order is unspecified: ignore the mock fixture's mount assignment
          // regardless of whether it runs before or after this accessor is installed.
          Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
            configurable: true,
            get: () => "",
            set: () => {},
          });
        });
        const pathname = "/ui/plugins/ch_bWF0cml4";
        await page.goto(suite.server.baseUrl.slice(0, -1) + pathname + "?probe=1#catalog");
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady === true);
        expect(
          await page.evaluate(
            () => (window as MockGatewayWindow)["__OPENCLAW_CONTROL_UI_BASE_PATH__"],
          ),
        ).toBe("");
        await page.screenshot({
          path: suite.artifactDir + "/catalog-startup.png",
          animations: "disabled",
        });
        await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
        await page.getByRole("heading", { name: "Matrix", exact: true, level: 1 }).waitFor();
        await page.reload();
        await page.getByRole("heading", { name: "Matrix", exact: true, level: 1 }).waitFor();
        expect(new URL(page.url()).pathname).toBe(pathname);
        expect(new URL(page.url()).search).toBe("?probe=1");
        expect(new URL(page.url()).hash).toBe("#catalog");
        await page.screenshot({
          path: suite.artifactDir + "/mounted-catalog.png",
          animations: "disabled",
        });
      },
    );
  });
});
