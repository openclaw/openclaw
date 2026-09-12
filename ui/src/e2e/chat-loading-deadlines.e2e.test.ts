import { expect, it } from "vitest";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat loading deadlines" });
const draft = "Keep this draft until I choose to send it.";
const readyText = "The conversation is ready.";

suite.define(() => {
  it.each(["chat.startup", "models.list"] as const)(
    "settles a silent %s read and preserves the draft through recovery",
    async (method) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.clock.install();
          if (method === "models.list") {
            await page.addInitScript(() => {
              const gateway = location.origin.replace(/^http/, "ws");
              localStorage.setItem(
                `openclaw.new-session.preferences.v1:${gateway}`,
                JSON.stringify({ agents: { main: { model: "openai/gpt-5.5" } } }),
              );
            });
          }
          const gateway = await installMockGateway(page, {
            sessionKey: "agent:main:main",
            heldMethods: [method],
            historyMessages: [{ role: "assistant", content: readyText }],
          });
          await page.goto(
            new URL(method === "models.list" ? "/new" : "/chat/main", suite.server.baseUrl).href,
          );
          await gateway.waitForRequest(method);
          const composer = page.locator("textarea:visible").first();
          await composer.fill(draft);
          await pauseVirtualClock(page);
          await page.clock.runFor(60_001);

          expect(await gateway.getSocketCount()).toBe(1);
          expect(await composer.inputValue()).toBe(draft);
          if (method === "chat.startup") {
            expect(await page.locator(".chat-history-error").textContent()).toContain("timed out");
            expect(await page.getByRole("button", { name: "Retry", exact: true }).isEnabled()).toBe(
              true,
            );
            expect(
              await page.getByRole("button", { name: "Loading chat", exact: true }).count(),
            ).toBe(0);
            const send = page.locator(".chat-send-btn--send");
            expect(await send.isDisabled()).toBe(true);
            expect(await send.getAttribute("aria-busy")).toBe("false");
          } else {
            expect(await page.locator('[data-chat-model-select="true"]').textContent()).toContain(
              "Models unavailable",
            );
            expect(
              await page
                .getByRole("button", { name: "Start session", exact: true })
                .getAttribute("aria-disabled"),
            ).toBe("false");
          }

          await gateway.resolveDeferred(method);
          await page.clock.runFor(1);
          if (method === "chat.startup") {
            expect(await page.getByText(readyText, { exact: true }).count()).toBe(0);
            await page.getByRole("button", { name: "Retry", exact: true }).click();
          } else {
            expect(await page.locator('[data-chat-model-select="true"]').textContent()).toContain(
              "Models unavailable",
            );
            await page.locator('[data-chat-model-select="true"]').click();
          }
          await page.clock.runFor(100);
          await expect.poll(async () => (await gateway.getRequests(method)).length).toBe(2);
          if (method === "chat.startup") {
            await page.getByText(readyText, { exact: true }).waitFor();
            expect(
              await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(),
            ).toBe(true);
          } else {
            expect(
              await page.locator('[data-chat-model-select="true"]').textContent(),
            ).not.toContain("Models unavailable");
          }
          expect(await composer.inputValue()).toBe(draft);
        },
      );
    },
  );
});
