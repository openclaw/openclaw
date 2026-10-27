import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { failControlUiModuleForDocuments } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const enabled = createControlUiE2eSuite({
  name: "Control UI browser capability gate enabled",
});

const guidance = (page: Page) =>
  page.getByRole("heading", { name: "Update your browser to use OpenClaw" });
function watchRequests(page: Page) {
  const counts = { recovery: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).searchParams.has("openclaw_mount_recovery")) {
      counts.recovery++;
    }
  });
  return counts;
}

async function setUnsupportedBrowser(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (feature: string, value?: string) => {
      if (feature === "anchor-name: --a") {
        return false;
      }
      return value === undefined ? supports(feature) : supports(feature, value);
    };
  });
}

enabled.define(() => {
  it.each([false, true])("shows a stable fallback (native host: %s)", (native) =>
    enabled.withPage(
      { viewport: { width: native ? 1180 : 390, height: 844 }, serviceWorkers: "block" },
      async ({ page }) => {
        await setUnsupportedBrowser(page);
        if (native) {
          await page.addInitScript(() => {
            const openclawLink = {
              postMessage: (message: unknown) => {
                document.documentElement.dataset.nativeLink = JSON.stringify(message);
              },
            };
            Object.defineProperty(window, "webkit", {
              value: { messageHandlers: { openclawLink } },
            });
          });
        }
        await page.clock.install();
        const gateway = await installMockGateway(page, { awaitInitialRoster: false });
        const url = `${enabled.server.baseUrl}chat?keep=yes#synthetic-fragment`;
        await page.goto(url);
        const heading = guidance(page);
        await heading.waitFor();
        expect(await page.locator("openclaw-app").count()).toBe(0);
        expect(await gateway.getRequests()).toEqual([]);
        const open = page.getByRole("button", { name: "Open in browser", exact: true });
        expect(await open.isVisible()).toBe(native);
        if (native) {
          await page.evaluate(() => {
            Object.defineProperty(URL, "parse", { configurable: true, value: undefined });
          });
          await open.click();
          expect(
            await page.evaluate(() => JSON.parse(document.documentElement.dataset.nativeLink!)),
          ).toEqual({
            type: "open-link",
            url,
            target: "external",
          });
          await page.getByRole("status").getByText("Opened in your default browser.").waitFor();
        }
        await page.clock.runFor(30_000);
        expect(page.url()).toBe(url);
        expect(await heading.isVisible()).toBe(true);
        expect(await gateway.getRequests()).toEqual([]);
      },
    ),
  );

  it("does not auto-reload a failed unsupported-screen download", () =>
    enabled.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await setUnsupportedBrowser(page);
      await page.clock.install();
      const counts = watchRequests(page);
      const failure = await failControlUiModuleForDocuments(
        page,
        /\/assets\/unsupported-browser-[^/]+\.js$/u,
      );
      await page.goto(`${enabled.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Browser guidance could not load" }).waitFor();
      await page.clock.runFor(30_000);
      expect(counts.recovery).toBe(0);
      expect(failure.documentCount()).toBe(1);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await guidance(page).waitFor();
      expect(failure.documentCount()).toBe(2);
    }));
});
