import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings disconnect regression" });
const sessionKey = "agent:main:session-a";
const prompt = "Please review the synthetic release notes.";

suite.define(() => {
  it("leaves settings wait recoverable when the connection drops in the Send event", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const main = page.getByRole("main");
        await main.locator('[data-chat-thinking-select="true"]').click();
        await gateway.deferNext("sessions.patch", { fastMode: true });
        await main.locator('[data-chat-speed-option="on"]').click();
        await gateway.waitForRequest("sessions.patch", { match: { fastMode: true } });
        await page.keyboard.press("Escape");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill(prompt);
        await page.evaluate(() => {
          const interrupt = (event: MouseEvent) => {
            if (
              !(event.target instanceof Element) ||
              !event.target.closest("button.chat-send-btn--send")
            ) {
              return;
            }
            window.removeEventListener("click", interrupt);
            (window as MockGatewayWindow).openclawControlUiE2eGateway!.setOnline(false);
          };
          window.addEventListener("click", interrupt);
        });
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator(".agent-chat__input--offline").waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.setOnline(true);
        await page.locator(".agent-chat__input--offline").waitFor({ state: "detached" });
        await expectBrowser(composer).toBeEnabled();
        const send = main.locator("button.chat-send-btn--send");
        await expectBrowser(send).toBeVisible();
        await expectBrowser(page.getByText("Applying chat settings", { exact: true })).toHaveCount(
          0,
        );
        await expectBrowser(composer).toHaveValue(prompt);
        await expectBrowser(page.locator(".chat-queue__item")).toHaveCount(0);
        await expectBrowser(send).toBeEnabled();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await send.click();
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({ sessionKey, message: prompt });
        await expectBrowser(composer).toHaveValue("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });
});
