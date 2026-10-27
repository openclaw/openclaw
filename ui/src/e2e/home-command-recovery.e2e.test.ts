import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Home command recovery across presentations",
});

suite.define(() => {
  it.each([
    { handoff: false, newerDraft: false },
    { handoff: true, newerDraft: false },
    { handoff: true, newerDraft: true },
  ])(
    "recovers a rejected command without replacing newer input (handoff=$handoff, newer=$newerDraft)",
    async ({ handoff, newerDraft }) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const homeKey = "agent:main:main";
        const command = "/steer QA recovery message";
        const newer = "QA newer draft stays here";
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
          sessionKey: homeKey,
          sessions: [{ key: homeKey, kind: "direct", label: "Main", updatedAt: 1 }],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
        const composer = page.locator("openclaw-chat-page .agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        await gateway.deferNext("chat.send", { queueMode: "steer" });
        await composer.fill(command);
        await composer.press("Enter");
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({
          sessionKey: homeKey,
          message: "QA recovery message",
          queueMode: "steer",
        });
        await expect.poll(() => composer.inputValue()).toBe("");

        const dockComposer = page.locator(
          "openclaw-assistant-panel .agent-chat__composer-combobox textarea",
        );
        if (handoff) {
          const pages = await openSidebarPages(page);
          await pages.getByRole("link", { name: "Sessions", exact: true }).click();
          await page.waitForURL((url) => url.pathname.endsWith("/sessions"));
          await page.locator("openclaw-sessions-page").waitFor();
          await page.getByRole("button", { name: "Talk to your Home agent", exact: true }).click();
          await dockComposer.waitFor({ state: "visible" });
          expect(new URL(page.url()).pathname).toBe("/sessions");
          expect(await composer.isVisible()).toBe(false);
          await expect.poll(() => dockComposer.inputValue()).toBe("");
          if (newerDraft) {
            await dockComposer.fill(newer);
          }
        }

        await gateway.rejectDeferred("chat.send", {
          code: "UNAVAILABLE",
          message: "QA synthetic command rejection",
        });
        if (handoff) {
          // The rail Home action toggles the dock; full-page navigation belongs to its header.
          await page
            .locator("openclaw-assistant-panel")
            .getByRole("button", { name: "Open Home full page", exact: true })
            .click();
          await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/main" });
          await composer.waitFor({ state: "visible" });
          await expect.poll(() => dockComposer.isVisible()).toBe(false);
        }
        await page
          .locator("openclaw-chat-page .chat-error", { hasText: "QA synthetic command rejection" })
          .waitFor({ state: "visible" });
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        await expect.poll(() => composer.inputValue()).toBe(newerDraft ? newer : command);
      });
    },
  );
});
