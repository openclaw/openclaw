import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const pageOptions = createDarkDesktopControlUiContextOptions();
async function withSetupPage(
  run: (page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) => Promise<void>,
  options: Parameters<typeof installMockGateway>[1] = { agentModel: null },
  width = 1440,
) {
  return suite.withPage({ ...pageOptions, viewport: { height: 900, width } }, async ({ page }) => {
    await run(page, await installMockGateway(page, options));
  });
}
async function expectSetupRoute(page: Page) {
  await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
  expect(new URL(page.url()).searchParams.get("connect")).toBe("1");
}

suite.define(() => {
  it("keeps help available on empty chat home while messages require a model", async () => {
    await withSetupPage(async (page, gateway) => {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__empty").waitFor();

      await expect.poll(() => page.locator(".agent-chat__composer-shell").count()).toBe(1);
      const textarea = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => textarea.isDisabled()).toBe(false);
      const welcome = page.locator(".agent-chat__welcome--setup");
      const setupAction = page.getByRole("button", { name: "Connect an AI provider", exact: true });
      await expect.poll(() => setupAction.count()).toBe(1);
      await setupAction.click();
      await expectSetupRoute(page);
      await page.goBack();
      const sendButton = page.getByRole("button", { name: "Send message", exact: true });
      await textarea.fill("/help");
      await expect.poll(() => sendButton.isDisabled()).toBe(false);
      await sendButton.click();
      await page.getByText("Available Commands", { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await expect.poll(() => welcome.count()).toBe(0);
      await expect.poll(() => setupAction.count()).toBe(1);
      await expect
        .poll(() =>
          page.locator(".agent-chat__composer-shell").evaluate((shell) => {
            const banner = shell.querySelector(".agent-chat__disabled-banner");
            const input = shell.querySelector(".agent-chat__input");
            if (!banner || !input) {
              throw new Error("expected setup notice above the composer");
            }
            return {
              stylesMatch: ["border-radius", "corner-shape"].every(
                (key) =>
                  getComputedStyle(banner).getPropertyValue(key) ===
                  getComputedStyle(input).getPropertyValue(key),
              ),
              edgesMatch: (["left", "right"] as const).every(
                (edge) =>
                  Math.abs(
                    banner.getBoundingClientRect()[edge] - input.getBoundingClientRect()[edge],
                  ) <= 1,
              ),
            };
          }),
        )
        .toEqual({ stylesMatch: true, edgesMatch: true });
      await setupAction.click();
      await expectSetupRoute(page);
      await page.goBack();
      await textarea.fill("Start a conversation.");
      await expect.poll(() => sendButton.isDisabled()).toBe(true);
      expect(await textarea.inputValue()).toBe("Start a conversation.");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each(["new", "custodian"])("blocks %s until a model is connected", async (surface) => {
    const custodian = surface === "custodian";
    await withSetupPage(
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}${custodian ? "custodian" : "new?agent=main"}`);
        await page.getByRole("heading", { name: "No AI provider configured" }).waitFor();
        const composer = custodian ? ".agent-chat__composer-shell" : ".new-session-page__composer";
        await expect.poll(() => page.locator(composer).count()).toBe(0);
        await expect.poll(() => page.locator("textarea").count()).toBe(0);
        if (custodian) {
          expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
          await expect.poll(() => page.locator(".custodian__error").count()).toBe(0);
          await expect
            .poll(async () => (await page.locator(".custodian__header").boundingBox())?.width ?? 0)
            .toBeGreaterThan(1_000);

          await page.setViewportSize({ height: 520, width: 900 });
          await expect
            .poll(() => page.getByRole("button", { name: "Connect an AI provider" }).isVisible())
            .toBe(true);
          await expect
            .poll(() =>
              page.evaluate(
                () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
              ),
            )
            .toBe(true);

          await page.setViewportSize({ height: 900, width: 1660 });
        }
        await page.getByRole("button", { name: "Connect an AI provider" }).click();
        await expectSetupRoute(page);
        if (custodian) {
          const modelsLink = page.locator(
            '.settings-sidebar__item[href="/settings/model-providers"]',
          );
          await expect.poll(() => modelsLink.getAttribute("aria-current")).toBe("page");
        }
      },
      {
        agentModel: null,
        ...(custodian
          ? { featureMethods: ["chat.metadata", "chat.startup", "openclaw.chat"] }
          : {}),
      },
      custodian ? 1660 : 1440,
    );
  });
});
