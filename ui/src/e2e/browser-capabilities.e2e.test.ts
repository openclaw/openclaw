import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  startProductionControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const builds = useAutoCleanupTempDirTracker(afterAll);
const enabledBuildId = "browser-capabilities-e2e";
const enabled = createControlUiE2eSuite({
  name: "Control UI browser capability gate enabled",
  startServer: async () => {
    vi.stubEnv("VITE_OPENCLAW_REQUIRE_MODERN_BROWSER", "true");
    try {
      return await startProductionControlUiE2eServer(
        builds.make("openclaw-browser-capabilities-"),
        enabledBuildId,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
});

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
  it.each([false, true])("shows a stable fallback (native host: %s)", async (native) => {
    await enabled.withPage(
      { viewport: { width: native ? 1180 : 390, height: 844 }, serviceWorkers: "block" },
      async ({ page }) => {
        await setBrowserFeatures(page, false);
        if (native) {
          await page.addInitScript(() => {
            Object.defineProperty(window, "webkit", {
              value: {
                messageHandlers: {
                  openclawLink: {
                    postMessage: (message: unknown) => {
                      document.documentElement.dataset.nativeLink = JSON.stringify(message);
                    },
                  },
                },
              },
            });
          });
        }
        await page.clock.install();
        const gateway = await installMockGateway(page, { awaitInitialRoster: false });
        const url = `${enabled.server.baseUrl}chat?keep=yes#synthetic-fragment`;
        await page.goto(url);
        const heading = page.getByRole("heading", { name: "Update your browser to use OpenClaw" });
        await heading.waitFor();
        expect(await page.getByText(/macOS 26.2 or iOS 26.2/).isVisible()).toBe(true);
        expect(
          await page.getByText(/Chrome or Firefox released within the last six months/).isVisible(),
        ).toBe(true);
        expect(await page.locator("openclaw-app").count()).toBe(0);
        expect(await gateway.getRequests()).toEqual([]);
        const open = page.getByRole("button", { name: "Open in browser", exact: true });
        expect(await open.isVisible()).toBe(native);
        const viewports = native
          ? [{ name: "macos", width: 1180, height: 844 }]
          : [
              { name: "desktop", width: 1180, height: 844 },
              { name: "mobile", width: 390, height: 844 },
            ];
        for (const viewport of viewports) {
          for (const colorScheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme });
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("main"),
              [heading],
              { animations: "disabled", viewport },
            );
            await writeFile(
              path.join(enabled.artifactDir, `unsupported-${viewport.name}-${colorScheme}.png`),
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
    );
  });

  it("keeps a slow unsupported-screen download alive beyond the mount deadline", async () => {
    const requested = createDeferred();
    const release = createDeferred();
    await enabled.withPage(
      { serviceWorkers: "block" },
      async ({ page }) => {
        await setBrowserFeatures(page, false);
        await page.clock.install();
        let recoveryRequests = 0;
        let documentRequests = 0;
        page.on("request", (request) => {
          if (new URL(request.url()).searchParams.has("openclaw_mount_recovery")) {
            recoveryRequests += 1;
          }
          if (request.resourceType() === "document") {
            documentRequests += 1;
          }
        });
        await page.route("**/assets/unsupported-browser-*.js", async (route) => {
          requested.resolve();
          await release.promise;
          await route.continue();
        });
        await page.goto(`${enabled.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
        await requested.promise;
        await page.clock.runFor(30_000);

        expect(recoveryRequests).toBe(0);
        expect(documentRequests).toBe(1);
        release.resolve();
        await page.getByRole("heading", { name: "Update your browser to use OpenClaw" }).waitFor();
        expect(documentRequests).toBe(1);
      },
      async () => release.resolve(),
    );
  });

  it("offers manual retry when the unsupported-screen download fails", async () => {
    await enabled.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await setBrowserFeatures(page, false);
      await page.clock.install();
      let failures = 0;
      let recoveryRequests = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).searchParams.has("openclaw_mount_recovery")) {
          recoveryRequests += 1;
        }
      });
      await page.route("**/assets/unsupported-browser-*.js", async (route) => {
        if (failures === 0) {
          failures += 1;
          await route.fulfill({ status: 503, body: "temporarily unavailable" });
        } else {
          await route.continue();
        }
      });
      await page.goto(`${enabled.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Browser guidance could not load" }).waitFor();
      await page.clock.runFor(30_000);
      expect(recoveryRequests).toBe(0);
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator("#openclaw-mount-fallback"),
        [page.getByRole("heading", { name: "Browser guidance could not load" })],
        { animations: "disabled" },
      );
      await writeFile(path.join(enabled.artifactDir, "unsupported-download-failed.png"), frame.png);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByRole("heading", { name: "Update your browser to use OpenClaw" }).waitFor();
      expect(failures).toBe(1);
    });
  });

  it.each([true, false])(
    "starts the application with required overlays (field sizing: %s)",
    async (fieldSizing) => {
      await enabled.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        await setBrowserFeatures(page, true, fieldSizing);
        const gateway = await installMockGateway(page, { serverBuildId: enabledBuildId });
        await page.goto(`${enabled.server.baseUrl}chat`);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect((await gateway.getRequests()).some((request) => request.method === "connect")).toBe(
          true,
        );
        expect(await page.locator(".unsupported-browser").count()).toBe(0);
      });
    },
  );
});

const dormant = createControlUiE2eSuite({ name: "Control UI browser capability gate dormant" });
dormant.define(() => {
  it("keeps today's application available on older browsers until cutover", async () => {
    await dormant.withPage({ serviceWorkers: "block", colorScheme: "light" }, async ({ page }) => {
      await setBrowserFeatures(page, false);
      await installMockGateway(page);
      await page.goto(`${dormant.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor();
      expect(await page.locator(".unsupported-browser").count()).toBe(0);
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator("openclaw-app"),
        [composer],
        {
          animations: "disabled",
        },
      );
      await writeFile(path.join(dormant.artifactDir, "before-dormant.png"), frame.png);
    });
  });
});
