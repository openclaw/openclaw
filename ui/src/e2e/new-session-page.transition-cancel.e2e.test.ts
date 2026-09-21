import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("retires the session entrance animation when Settings takes over", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), reducedMotion: "no-preference" },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".new-session-page__message").fill("leave this session entrance");
        await page.evaluate(() => {
          const outlet = document.querySelector("openclaw-router-outlet");
          if (!(outlet instanceof HTMLElement)) {
            throw new Error("Expected the application router outlet");
          }
          let resolve!: (animation: Animation) => void;
          const ready = new Promise<Animation>((next) => {
            resolve = next;
          });
          Reflect.set(globalThis, "__routeEntranceAnimation", ready);
          const animate = outlet.animate.bind(outlet);
          outlet.animate = (keyframes, options) => {
            const animation = animate(keyframes, options);
            // Hold the actual animation at a deterministic point in its 180 ms lifetime.
            animation.pause();
            animation.currentTime = 0;
            resolve(animation);
            return animation;
          };
        });
        await page.getByRole("button", { name: "Start session" }).click();
        await gateway.waitForRequest("sessions.create");
        expect(
          await page.evaluate(async () => {
            const animation = (await Reflect.get(
              globalThis,
              "__routeEntranceAnimation",
            )) as Animation;
            return animation.playState;
          }),
        ).toBe("paused");

        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(".sidebar-identity-card").click();
        await sidebar
          .locator("wa-dropdown.sidebar-identity-menu")
          .getByRole("menuitem", { exact: true, name: "Settings" })
          .click();
        await page.waitForURL((url) => url.pathname === "/settings/appearance");
        await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "settings-after-session.png"),
          });
        }
        expect(
          await page.evaluate(async () => {
            const animation = (await Reflect.get(
              globalThis,
              "__routeEntranceAnimation",
            )) as Animation;
            return animation.playState;
          }),
        ).toBe("idle");
      },
    );
  });
});
