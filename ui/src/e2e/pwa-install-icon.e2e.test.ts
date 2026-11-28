import { expect, it } from "vitest";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("uses the saved picture for installation across reloads without changing the browser tab icon", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1280, height: 800 }, colorScheme: "light" },
      async ({ page, context }) => {
        const base = new URL(suite.server.baseUrl);
        const prefix = "/pwa-icon/" + "a".repeat(64);
        const icon = prefix + "/icon.png";
        const manifest = prefix + "/manifest.webmanifest";
        const agentIcon = "/pwa-icon/" + "b".repeat(64) + "/icon.png";
        const touchIcon = prefix + "/apple-touch-icon.png";
        const uploads = new Map<string, Buffer>();
        await installMockGateway(page, {
          methodResponses: { "config.get": configResponse({}, "icon-proof") },
        });
        await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
        // A namespaced settings route can use assets/APIs from the root mount.
        await page.addInitScript(() => {
          Object.assign(window, { __OPENCLAW_CONTROL_UI_BASE_PATH__: "" });
        });
        await page.route(new URL("/pwa-icon", base).href, async (route) => {
          const req = route.request();
          expect(req.headers()["x-openclaw-install-device"]).toBeTruthy();
          if (req.method() === "DELETE") {
            await route.fulfill({ status: 204 });
            return;
          }
          expect(req.method()).toBe("POST");
          expect(req.headers()["content-type"]).toBe("image/png");
          const uploaded = req.postDataBuffer();
          expect(uploaded?.subarray(1, 4).toString()).toBe("PNG");
          expect(uploaded?.readUInt32BE(16)).toBe(512);
          expect(uploaded?.readUInt32BE(20)).toBe(512);
          const iconUrl = uploads.size === 0 ? agentIcon : icon;
          if (!uploaded) {
            throw new Error("Install icon POST requires image bytes");
          }
          uploads.set(iconUrl, uploaded);
          await route.fulfill({
            json: { iconUrl, manifestUrl: iconUrl.replace("icon.png", "manifest.webmanifest") },
          });
        });
        await page.route("**/pwa-icon/*/icon.png", (route) => {
          const png = uploads.get(new URL(route.request().url()).pathname);
          return png
            ? route.fulfill({ contentType: "image/png", body: png })
            : route.fulfill({ status: 404 });
        });
        await page.route(new URL(manifest, base).href, (route) =>
          route.fulfill({
            contentType: "application/manifest+json",
            json: {
              id: "/",
              name: "OpenClaw Control",
              start_url: "/",
              scope: "/",
              display: "standalone",
              icons: [{ src: "./icon.png", sizes: "512x512", type: "image/png" }],
            },
          }),
        );
        await page.goto(new URL("/work/settings/appearance", base).href);
        const card = page.locator("#settings-appearance-installed-app-icon");
        await card.waitFor();
        const favicon = page.locator("#openclaw-favicon-png");
        const tabIcon = await favicon.getAttribute("href");
        const appleIcon = page.locator('link[rel="apple-touch-icon"]');
        const manifestLink = page.locator('link[rel="manifest"]');
        const defaultManifest = requireString(
          await manifestLink.getAttribute("href"),
          "default install manifest",
        );
        expect(new URL(defaultManifest, base).pathname).toBe("/manifest.webmanifest");
        const artwork = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 72;
          canvas.height = 64;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            throw new Error("Canvas unavailable");
          }
          ctx.fillStyle = "#126368";
          ctx.fillRect(0, 0, 72, 64);
          ctx.fillStyle = "#fff5c4";
          ctx.beginPath();
          ctx.moveTo(36, 8);
          ctx.lineTo(58, 32);
          ctx.lineTo(36, 56);
          ctx.lineTo(14, 32);
          ctx.closePath();
          ctx.fill();
          return canvas.toDataURL("image/png").split(",")[1];
        });
        await card.getByRole("button", { name: "Use current agent picture" }).click();
        await expect
          .poll(() => appleIcon.getAttribute("href"))
          .toBe(agentIcon.replace("icon.png", "apple-touch-icon.png"));
        await card.getByRole("button", { name: "Use OpenClaw default" }).click();
        await expect.poll(() => manifestLink.getAttribute("href")).toBe(defaultManifest);
        const chooser = page.waitForEvent("filechooser");
        await card.getByRole("button", { name: /Upload custom picture/ }).click();
        await (
          await chooser
        ).setFiles({
          name: "diamond.png",
          mimeType: "image/png",
          buffer: Buffer.from(requireString(artwork, "synthetic picture"), "base64"),
        });
        await expect.poll(() => appleIcon.getAttribute("href")).toBe(touchIcon);
        await page
          .locator("#settings-appearance-tab-icon")
          .evaluate((el) => el.scrollIntoView({ block: "start" }));
        await captureUiProof(suite, page, "pwa-install-icon", "after.png");

        const cdp = await context.newCDPSession(page);
        for (const reload of [false, true]) {
          if (reload) {
            await page.reload();
            await card.waitFor();
          }
          await expect.poll(() => manifestLink.getAttribute("href")).toBe(manifest);
          expect(await appleIcon.getAttribute("href")).toBe(touchIcon);
          expect(await favicon.getAttribute("href")).toBe(tabIcon);
          expect(
            await card
              .locator("img")
              .evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth)),
          ).toBe(512);
          // Exercise Chromium's install manifest loader, not a scripted fetch.
          const installed = await cdp.send("Page.getAppManifest");
          expect(installed).toMatchObject({ url: new URL(manifest, base).href, errors: [] });
          expect(JSON.parse(installed.data ?? "null").icons).toMatchObject([{ src: "./icon.png" }]);
        }
        await card.getByRole("button", { name: "Use OpenClaw default" }).click();
        await expect.poll(() => manifestLink.getAttribute("href")).toBe(defaultManifest);
        await page.reload();
        await card.waitFor();
        expect(await manifestLink.getAttribute("href")).toBe(defaultManifest);
        expect(
          new URL(
            requireString(await appleIcon.getAttribute("href"), "default apple touch icon"),
            base,
          ).pathname,
        ).toBe("/apple-touch-icon.png");
        expect((await cdp.send("Page.getAppManifest")).url).toBe(
          new URL(defaultManifest, base).href,
        );
      },
    );
  });
});
