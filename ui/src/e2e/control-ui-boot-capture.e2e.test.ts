import { expect, it } from "vitest";
import { deferControlUiBootSpeculation } from "../../scripts/control-ui-boot-capture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const origin = "http://boot-capture.test";
const suite = createControlUiE2eSuite({
  name: "Control UI boot capture",
  // Every document/module response belongs to this test's route fixture.
  startServer: async () => ({ baseUrl: origin, close: async () => {} }),
});

const modules: Record<string, string> = {
  "/direct.js": "export const ready = true;",
  "/timer.js": "export const persisted = true;",
  "/deadline.js": "localStorage.setItem('deadline-read', 'ready');",
  "/warm.js":
    "if (localStorage.getItem('deadline-read') !== 'ready') throw new Error('Missing deadline reader');",
  "/idle-parent.js": "void import('/idle-child.js');",
  "/idle-child.js": "export const speculative = true;",
  "/cancelled.js": "throw new Error('Canceled idle work ran');",
};
const documentSource = `<script type="module">
  const warm = localStorage.getItem("boot-marker") === "ready";
  await import("/direct.js");
  requestIdleCallback(() => void import("/deadline.js"), { timeout: 1000 });
  const canceled = requestIdleCallback(() => void import("/cancelled.js"), { timeout: 1000 });
  cancelIdleCallback(canceled);
  setTimeout(() => void import("/timer.js").then(() => localStorage.setItem("boot-marker", "ready")), 500);
  setTimeout(() => requestIdleCallback(() => void import("/idle-parent.js")), 500);
  if (warm) await import("/warm.js");
  document.body.textContent = "ready";
</script>`;

suite.define(() => {
  it("captures ready and warm readers without promoting timeoutless idle descendants", () =>
    suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
      await context.addInitScript(deferControlUiBootSpeculation);
      const requested = new Set<string>();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith(".js")) {
          requested.add(pathname);
        }
      });
      await page.route(`${origin}/**`, (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const body = pathname === "/" ? documentSource : modules[pathname];
        if (body === undefined) {
          throw new Error(`Unexpected boot capture request: ${pathname}`);
        }
        return route.fulfill({
          body,
          contentType: pathname === "/" ? "text/html" : "text/javascript",
        });
      });
      for (const warm of [false, true]) {
        if (warm) {
          await page.reload();
        } else {
          await page.goto(origin);
        }
        await page.waitForFunction(() => document.body.textContent === "ready");
        await page.waitForFunction(() => localStorage.getItem("boot-marker") === "ready");
        // Match the generator: allow ordinary/deadline work after ready, including reload.
        await page.waitForTimeout(3_000);
      }
      expect(errors).toEqual([]);
      for (const module of ["/direct.js", "/timer.js", "/deadline.js", "/warm.js"]) {
        expect(requested.has(module), module).toBe(true);
      }
      expect(requested.has("/cancelled.js")).toBe(false);
      expect(requested.has("/idle-parent.js")).toBe(false);
      expect(requested.has("/idle-child.js")).toBe(false);
    }));
});
