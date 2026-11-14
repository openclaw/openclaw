import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  startControlUiE2eServer,
  type MockGatewayWindow,
} from "../../test-helpers/control-ui-e2e.ts";
import { matrixDetail, pluginMethodResponses, pluginMethods } from "./plugins.e2e.test-support.ts";
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
  it.each([
    ["Linear", "ch_QG9wZW5jbGF3L2xpbmVhcg", "/ui/plugins/openclaw/linear", false],
    ["Matrix", "ch_bWF0cml4", "/ui/plugins/ch_bWF0cml4", true],
  ] as const)("reloads %s catalog links from %s", async (name, id, pathname, inferMount) => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const summary = "Find, create, and update Linear issues, projects, and comments.";
        const plugin = {
          ...matrixDetail.plugin,
          id,
          catalog: { ...matrixDetail.plugin.catalog, name, summary },
        };
        if (inferMount) {
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.addInitScript(() => {
            // Init-script order is unspecified: ignore the mock fixture's mount assignment.
            Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
              configurable: true,
              get: () => "",
              set: () => {},
            });
          });
        }
        const gateway = await installMockGateway(page, {
          basePath,
          featureMethods: pluginMethods,
          methodResponses: {
            ...pluginMethodResponses(),
            ...(!inferMount && {
              "plugins.catalog.browse": { items: [plugin] },
              "plugins.catalog.get": {
                plugin,
                detail: {
                  ...matrixDetail.detail,
                  packageName: "@openclaw/linear",
                  readme: summary,
                },
              },
            }),
          },
        });
        const origin = suite.server.baseUrl.slice(0, -1);
        await page.goto(origin + "/ui/plugins/" + id + "?probe=1#catalog");
        if (inferMount) {
          await page.waitForFunction(
            () => window.openclawControlUi?.snapshot().routeReady === true,
          );
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
        }
        const heading = page.getByRole("heading", { name, exact: true, level: 1 });
        await heading.waitFor();
        if (!inferMount) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".content"),
            [heading],
            { animations: "disabled" },
          );
          await writeFile(suite.artifactDir + "/linear-detail.png", frame.png);
        }
        expect(new URL(page.url()).pathname).toBe(pathname);
        await page.reload();
        await heading.waitFor();
        expect(new URL(page.url()).pathname).toBe(pathname);
        expect(new URL(page.url()).search).toBe("?probe=1");
        expect(new URL(page.url()).hash).toBe("#catalog");
        if (inferMount) {
          await page.screenshot({
            path: suite.artifactDir + "/mounted-catalog.png",
            animations: "disabled",
          });
          return;
        }
        expect((await gateway.getRequests("plugins.catalog.get", { id })).length).toBeGreaterThan(
          0,
        );
        await page.goto(origin + "/ui/plugins");
        const link = page
          .getByRole("region", { name: "Explore plugins" })
          .getByRole("link", { name, exact: true })
          .first();
        await link.waitFor();
        expect(await link.getAttribute("href")).toBe(pathname);
        // The publisher link occupies the card center; its padding opens the plugin.
        await link.click({ position: { x: 16, y: 16 } });
        await heading.waitFor();
        expect(new URL(page.url()).pathname).toBe(pathname);
        await page.goBack();
        await link.waitFor();
        expect(new URL(page.url()).pathname).toBe("/ui/plugins");
      },
    );
  });
});
