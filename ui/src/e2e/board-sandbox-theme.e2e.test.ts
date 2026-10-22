import { expect, it } from "vitest";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Dashboard sandbox first-paint theme" });

suite.define(() => {
  const sandbox = useCanvasSandboxFixture();
  it.each(["light", "dark"] as const)(
    "starts %s before host theme delivery and retains later theme changes",
    async (mode) => {
      await suite.withPage(
        { serviceWorkers: "block", permissions: ["local-network-access"] },
        async ({ page }) => {
          const metadata = sandbox("");
          const source = new URL(metadata.sandboxUrl, suite.server.baseUrl);
          source.port = String(metadata.sandboxPort);
          source.hash = `theme=${mode}`;
          await page.addInitScript(() => {
            let themes = 0;
            window.addEventListener("message", (event) => {
              if (event.data?.type === "openclaw:widget-theme") {
                themes += 1;
              }
            });
            const observer = new MutationObserver(() => {
              if (!document.querySelector("iframe")) {
                return;
              }
              document.documentElement.dataset.initialCanvas = JSON.stringify({
                scheme: getComputedStyle(document.documentElement).colorScheme,
                themes,
              });
              observer.disconnect();
            });
            observer.observe(document, { childList: true, subtree: true });
          });
          await page.route("**/sandbox-theme-proof", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html style="color-scheme:${mode}"><body>
                <output id="ready"></output><script>
                const frame = document.createElement("iframe");
                frame.style.colorScheme = ${JSON.stringify(mode)};
                frame.sandbox = "allow-scripts allow-same-origin allow-forms";
                frame.src = ${JSON.stringify(source.href)};
                window.addEventListener("message", event => {
                  if (event.source === frame.contentWindow && event.data?.method === "ui/notifications/sandbox-proxy-ready") {
                    document.querySelector("#ready").textContent = event.data.params.sandboxUrl;
                  }
                });
                document.body.append(frame);
                </script></body></html>`,
            }),
          );
          await page.goto(new URL("sandbox-theme-proof", suite.server.baseUrl).href);
          await page.locator("#ready").filter({ hasText: source.href }).waitFor();
          const outer = page.frameLocator("iframe");
          expect(await outer.locator("html").getAttribute("data-initial-canvas")).toBe(
            JSON.stringify({ scheme: mode, themes: 0 }),
          );
          expect(
            await outer.locator("html").evaluate((root) => getComputedStyle(root).backgroundColor),
          ).toBe("rgba(0, 0, 0, 0)");

          const next = mode === "light" ? "dark" : "light";
          await page.locator("iframe").evaluate((frame, theme) => {
            const iframe = frame as HTMLIFrameElement;
            iframe.style.colorScheme = theme;
            iframe.contentWindow?.postMessage(
              { type: "openclaw:widget-theme", mode: theme, tokens: {} },
              new URL(iframe.src).origin,
            );
          }, next);
          await outer.locator(`html[style*="color-scheme: ${next}"]`).waitFor();
          expect(await page.locator("iframe").getAttribute("src")).toBe(source.href);
          expect(await outer.locator("html").getAttribute("data-initial-canvas")).toBe(
            JSON.stringify({ scheme: mode, themes: 0 }),
          );
        },
      );
    },
  );
});
