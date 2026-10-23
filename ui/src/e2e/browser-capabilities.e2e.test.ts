import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { failControlUiModuleForDocuments } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const enabled = createControlUiE2eSuite({
  name: "Control UI browser capability gate enabled",
});

const guidance = (page: Page) =>
  page.getByRole("heading", { name: "Update your browser to use OpenClaw" });
function watchRequests(page: Page) {
  const counts = { recovery: 0, documents: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).searchParams.has("openclaw_mount_recovery")) {
      counts.recovery++;
    }
    if (request.resourceType() === "document") {
      counts.documents++;
    }
  });
  return counts;
}

async function setBrowserFeatures(
  page: Page,
  supported: boolean,
  fieldSizing = supported,
): Promise<void> {
  await page.addInitScript(
    ({ supported: available, fieldSizing: availableFieldSizing }) => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (feature: string, value?: string) => {
        if (feature === "anchor-name: --a") {
          return available;
        }
        if (feature === "field-sizing: content") {
          return availableFieldSizing;
        }
        return value === undefined ? supports(feature) : supports(feature, value);
      };
      Object.defineProperty(HTMLElement.prototype, "showPopover", {
        configurable: true,
        value: available ? () => {} : undefined,
      });
      Object.defineProperty(HTMLButtonElement.prototype, "commandForElement", {
        configurable: true,
        value: null,
      });
    },
    { supported, fieldSizing },
  );
}

enabled.define(() => {
  it.each([false, true])("shows a stable fallback (native host: %s)", (native) =>
    enabled.withPage(
      { viewport: { width: native ? 1180 : 390, height: 844 }, serviceWorkers: "block" },
      async ({ page }) => {
        await setBrowserFeatures(page, false);
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
        expect(await page.getByText(/macOS 26.2 or iOS 26.2/).isVisible()).toBe(true);
        expect(
          await page.getByText(/Chrome or Firefox released within the last six months/).isVisible(),
        ).toBe(true);
        expect(await page.locator("openclaw-app").count()).toBe(0);
        expect(await gateway.getRequests()).toEqual([]);
        const open = page.getByRole("button", { name: "Open in browser", exact: true });
        expect(await open.isVisible()).toBe(native);
        for (const name of native ? ["macos"] : ["desktop", "mobile"]) {
          const viewport = { name, width: name === "mobile" ? 390 : 1180, height: 844 };
          for (const colorScheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme });
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("main"),
              [heading],
              { animations: "disabled", viewport },
            );
            await writeFile(
              path.join(enabled.artifactDir, `unsupported-${name}-${colorScheme}.png`),
              frame.png,
            );
          }
        }
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

  it.each(["slow", "failed"] as const)(
    "does not auto-reload a %s unsupported-screen download",
    async (mode) => {
      const requested = createDeferred(),
        release = createDeferred();
      await enabled.withPage(
        { serviceWorkers: "block" },
        async ({ page }) => {
          await setBrowserFeatures(page, false);
          await page.clock.install();
          const counts = watchRequests(page);
          const failure =
            mode === "failed"
              ? await failControlUiModuleForDocuments(
                  page,
                  /\/assets\/unsupported-browser-[^/]+\.js$/u,
                )
              : undefined;
          if (!failure) {
            await page.route("**/assets/unsupported-browser-*.js", async (route) => {
              requested.resolve();
              await release.promise;
              await route.continue();
            });
          }
          await page.goto(`${enabled.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
          const heading = page.getByRole("heading", { name: "Browser guidance could not load" });
          if (failure) {
            await heading.waitFor();
          } else {
            await requested.promise;
          }
          await page.clock.runFor(30_000);
          expect(counts.recovery).toBe(0);
          expect(failure?.documentCount() ?? counts.documents).toBe(1);
          if (failure) {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("#openclaw-mount-fallback"),
              [heading],
              { animations: "disabled" },
            );
            await writeFile(
              path.join(enabled.artifactDir, "unsupported-download-failed.png"),
              frame.png,
            );
            await page.getByRole("button", { name: "Try again", exact: true }).click();
          } else {
            release.resolve();
          }
          await guidance(page).waitFor();
          expect(failure?.documentCount() ?? counts.documents).toBe(failure ? 2 : 1);
        },
        async () => release.resolve(),
      );
    },
  );

  it.each([true, false])(
    "starts the application with required overlays (field sizing: %s)",
    (fieldSizing) =>
      enabled.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        await setBrowserFeatures(page, true, fieldSizing);
        const gateway = await installMockGateway(page);
        await page.goto(`${enabled.server.baseUrl}chat`);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect((await gateway.getRequests()).some((request) => request.method === "connect")).toBe(
          true,
        );
        expect(await page.locator(".unsupported-browser").count()).toBe(0);
      }),
  );
});
