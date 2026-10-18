import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "New Session revisit" });

async function failDraftRender(page: Page, persistFailure: boolean, failInitially = true) {
  await page.addInitScript(
    ({ persistent, initial }) => {
      const boots = Number(sessionStorage.getItem("test.newSessionBoots") ?? "0") + 1;
      sessionStorage.setItem("test.newSessionBoots", String(boots));
      Reflect.set(globalThis, "failNewSessionRender", initial && (persistent || boots === 1));
      const defineProperty = Object.defineProperty;
      Object.defineProperty = (target, key, descriptor) => {
        if (
          target instanceof HTMLElement &&
          target.localName === "openclaw-new-session-page" &&
          key === "data" &&
          descriptor.get
        ) {
          const read = descriptor.get.bind(target);
          return defineProperty(target, key, {
            ...descriptor,
            get() {
              if (Reflect.get(globalThis, "failNewSessionRender")) {
                throw new Error("Synthetic draft renderer failure");
              }
              return read();
            },
          });
        }
        return defineProperty(target, key, descriptor);
      };
    },
    { persistent: persistFailure, initial: failInitially },
  );
}

suite.define(() => {
  it("automatically reloads once and restores a working new session composer", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { awaitInitialRoster: false });
        await failDraftRender(page, false);
        await page.goto(suite.server.baseUrl + "new?agent=main");
        const composer = page.locator(".new-session-page__message");
        await composer.waitFor({ state: "visible", timeout: 10_000 });
        expect(await page.evaluate(() => sessionStorage.getItem("test.newSessionBoots"))).toBe("2");
        await composer.fill("Recovered automatically");
        await composer.press("Enter");
        await gateway.waitForRequest("sessions.create");
        await page.locator("openclaw-chat-page").waitFor({ state: "visible" });
      },
    );
  });
  it("shows a retry instead of a blank page when the native draft renderer fails", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        // This test intentionally prevents the initial route from becoming ready.
        const gateway = await installMockGateway(page, { awaitInitialRoster: false });
        await failDraftRender(page, true);
        await page.goto(suite.server.baseUrl + "new?agent=main");
        await page.waitForFunction(() => sessionStorage.getItem("test.newSessionBoots") === "2");
        const error = page.locator("openclaw-new-session-page .lazy-view-error");
        try {
          await error.waitFor({ state: "visible", timeout: 5000 });
        } catch (failure) {
          await page.screenshot({ path: path.join(suite.artifactDir, "before-blank.png") });
          throw failure;
        }
        await writeFile(
          path.join(suite.artifactDir, "after-visible-error.png"),
          (
            await takeControlUiScreenshotFrame(page, page.locator(".shell"), [error], {
              animations: "disabled",
            })
          ).png,
        );
        // A manual retry of the persistent failure must not trigger a third document load.
        await error.getByRole("button", { name: "Retry", exact: true }).click();
        await error.waitFor({ state: "visible" });
        expect(await page.evaluate(() => sessionStorage.getItem("test.newSessionBoots"))).toBe("2");
        await page.evaluate(() => Reflect.set(globalThis, "failNewSessionRender", false));
        await error.getByRole("button", { name: "Retry", exact: true }).click();
        const composer = page.locator(".new-session-page__message");
        await composer.fill("Recovered without a browser refresh");
        expect(await composer.inputValue()).toBe("Recovered without a browser refresh");
        expect(await error.count()).toBe(0);
        await writeFile(
          path.join(suite.artifactDir, "after-retry.png"),
          (
            await takeControlUiScreenshotFrame(page, page.locator(".shell"), [composer], {
              animations: "disabled",
            })
          ).png,
        );
        await composer.press("Enter");
        await gateway.waitForRequest("sessions.create");
        await page.locator("openclaw-chat-page").waitFor({ state: "visible" });
      },
    );
  });

  it("keeps a draft and avoids automatic reload after the composer was usable", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        await installMockGateway(page);
        await failDraftRender(page, false, false);
        await page.goto(suite.server.baseUrl + "new?agent=main");
        const composer = page.locator(".new-session-page__message");
        await composer.fill("Keep this unsent draft");
        await page.evaluate(() => {
          const host = document.querySelector("openclaw-new-session-page");
          if (!host) {
            throw new Error("Missing New Session host");
          }
          const data = { ...Reflect.get(host, "data") };
          Reflect.set(globalThis, "failNewSessionRender", true);
          Reflect.set(host, "data", data);
        });
        const error = page.locator("openclaw-new-session-page .lazy-view-error");
        await error.waitFor({ state: "visible" });
        await page.evaluate(() => Reflect.set(globalThis, "failNewSessionRender", false));
        await error.getByRole("button", { name: "Retry", exact: true }).click();
        await composer.waitFor({ state: "visible" });
        expect(await composer.inputValue()).toBe("Keep this unsent draft");
        expect(await page.evaluate(() => sessionStorage.getItem("test.newSessionBoots"))).toBe("1");
      },
    );
  });

  it("returns to plus after canceling a pending chat load", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(suite.server.baseUrl + "new?agent=main");
        const composer = page.locator(".new-session-page__message");
        await composer.fill("Pending chat navigation");
        await gateway.deferNext("chat.startup");
        await composer.press("Enter");
        await gateway.waitForRequest("chat.startup");
        await page.getByRole("link", { name: "New conversation" }).first().click();
        await composer.waitFor({ state: "visible" });
        await gateway.resolveDeferred("chat.startup");
        await composer.fill("Still usable");
        expect(await composer.inputValue()).toBe("Still usable");
      },
    );
  });

  it("returns to plus after a rejected create restores the original page", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(suite.server.baseUrl + "new?agent=main");
        const composer = page.locator(".new-session-page__message");
        await composer.fill("Rejected session creation");
        await gateway.deferNext("sessions.create");
        await composer.press("Enter");
        await gateway.waitForRequest("sessions.create");
        await page.locator("openclaw-chat-page").waitFor({ state: "visible" });
        await gateway.rejectDeferred("sessions.create", {
          code: "UNAVAILABLE",
          message: "Synthetic rejection",
        });
        await composer.waitFor({ state: "visible" });
        await page.getByRole("link", { name: "New conversation" }).first().click();
        await composer.waitFor({ state: "visible" });
        await composer.fill("Retry after rollback");
        await composer.press("Enter");
        await gateway.waitForRequest("sessions.create", { after: 1 });
        await page.locator("openclaw-chat-page").waitFor({ state: "visible" });
        await page.getByRole("link", { name: "New conversation" }).first().click();
        await composer.waitFor({ state: "visible" });
        expect(await composer.isEnabled()).toBe(true);
      },
    );
  });
  it("keeps the plus destination populated across repeated chat visits", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(suite.server.baseUrl + "new");
        const composer = page.locator(".new-session-page__message");
        await composer.waitFor({ state: "visible" });
        for (let visit = 0; visit < 2; visit++) {
          await composer.fill("Revisit session " + visit);
          await composer.press("Enter");
          await gateway.waitForRequest("sessions.create", { after: visit });
          await page.locator("openclaw-chat-page").waitFor({ state: "visible" });
          await page.getByRole("link", { name: "New conversation" }).first().click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
          try {
            await composer.waitFor({ state: "visible", timeout: 5000 });
          } catch (error) {
            await page.screenshot({
              path: path.join(suite.artifactDir, "blank-" + visit + ".png"),
            });
            throw error;
          }
          expect(await composer.isEnabled()).toBe(true);
        }
        const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [composer], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "new-session-revisited.png"), frame.png);
      },
    );
  });
});
