import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  chatMessage,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { settingsRow } from "./config-composer-fixtures.test-support.ts";
import { expectNoRequests, requestCount } from "./session-management.compact.test-support.ts";
import { expectCount, expectText } from "./sidebar-assertions.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("hides and restores chat progress across tabs and reloads while keeping saved Details", async () => {
    const sessionKey = "agent:main:progress-preference";
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 390, height: 900 } },
      async ({ page, context }) => {
        const cardData = {
          sessionKey,
          revision: 1,
          updatedAt: Date.now(),
          steps: [{ step: "Verify the new preference", status: "in_progress" }],
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          historyMessages: [
            chatMessage("user", "Show progress."),
            chatMessage("assistant", "Working."),
          ],
          methodResponses: {
            "progressCard.get": { card: cardData },
            "sessions.list": chatSessionListResponse([
              { key: sessionKey, kind: "direct", label: "Progress", updatedAt: 1 },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pill = page.locator('.activity-pill[data-family="progress"]');
        await pill.waitFor();
        const progress = await openChatTaskProgress(page);
        await progress.locator(".task-progress-details__plan").waitFor();
        await closeChatDetails(page);

        const settingsPage = await context.newPage();
        await settingsPage.setViewportSize({ width: 1280, height: 900 });
        const settingsGateway = await installMockGateway(settingsPage, { sessionKey });
        await settingsPage.goto(
          `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-chat`,
        );
        await waitForControlUiSettingsTakeover(settingsPage);
        const showRow = settingsRow(settingsPage, "Show task progress cards").first();
        const collapseRow = settingsRow(
          settingsPage,
          "Collapse task progress by default on desktop",
        ).first();
        const enabled = () => showRow.getByRole("switch").isChecked();
        await expect.poll(enabled).toBe(true);
        await expect.poll(() => showRow.textContent()).not.toContain("Using default:");

        await collapseRow.click();
        await showRow.click();
        await expect.poll(enabled).toBe(false);
        await expect.poll(() => collapseRow.getByRole("switch").isDisabled()).toBe(true);
        await expectCount(pill, 0);

        const reads = await requestCount(gateway, "progressCard.get");
        const progressed = "The task progressed while the card was hidden.";
        const updatedCard = { ...cardData, revision: 2, markdown: progressed };
        await gateway.setMethodResponse("progressCard.get", { card: updatedCard });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect.poll(() => requestCount(gateway, "progressCard.get")).toBeGreaterThan(reads);
        await openChatTaskProgress(page);
        await expectText(progress, progressed);
        await closeChatDetails(page);
        expect(await pill.count()).toBe(0);
        // Each page-owned request log resets on reload; prove the first phase before losing it.
        await expectNoRequests(gateway, "progressCard.put", "chat.abort");
        await expectNoRequests(settingsGateway, "config.patch");
        await page.reload();
        await page.locator(".agent-chat__composer-combobox textarea").waitFor({ state: "visible" });
        expect(await pill.count()).toBe(0);
        // The preference hides chat presentation; saved Details still reads current progress.
        await gateway.waitForRequest("progressCard.get");
        await openChatTaskProgress(page);
        await expectText(progress, progressed);
        await closeChatDetails(page);
        expect(await pill.count()).toBe(0);
        await settingsPage.reload();
        await waitForControlUiSettingsTakeover(settingsPage);
        await expect.poll(enabled).toBe(false);

        await showRow.click();
        await expect.poll(enabled).toBe(true);
        await pill.waitFor();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator(".chat-details-toggle").waitFor();
        const card = await openChatTaskProgress(page);
        await expectText(card, progressed);
        expect(await card.getAttribute("open")).toBeNull();
        const persisted = await settingsPage.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        );
        expect(persisted.chatCollapseTaskProgress).toBe(true);
        expect(persisted).not.toHaveProperty("chatShowTaskProgress");
        await expectNoRequests(gateway, "progressCard.put", "chat.abort");
        await expectNoRequests(settingsGateway, "config.patch");
      },
    );
  });
});
