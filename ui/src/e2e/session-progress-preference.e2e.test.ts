import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatMessage,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { settingsRow } from "./config-composer-fixtures.test-support.ts";
import { expectNoRequests, requestCount } from "./session-management.compact.test-support.ts";
import { expectText, expectVisible } from "./sidebar-assertions.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps saved Details current while the chat progress preference is disabled", async () => {
    const sessionKey = "agent:main:progress-preference";
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1280, height: 900 } },
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
        const card = page.locator('[data-progress-card-placement="details"]');
        await openChatDetails(page);
        await expectVisible(card);

        const settingsPage = await context.newPage();
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
        await expect.poll(() => card.isVisible()).toBe(true);

        const reads = await requestCount(gateway, "progressCard.get");
        const progressed = "The task progressed while the card was hidden.";
        const updatedCard = { ...cardData, revision: 2, markdown: progressed };
        await gateway.setMethodResponse("progressCard.get", { card: updatedCard });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect
          .poll(async () => (await gateway.getRequests("progressCard.get")).length)
          .toBeGreaterThan(reads);
        await expect
          .poll(() => card.textContent())
          .toContain("The task progressed while the card was hidden.");
        // Reload resets the page-owned request log; check this phase before navigating.
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        expect(await settingsGateway.getRequests("config.patch")).toHaveLength(0);
        await page.reload();
        await page.locator(".agent-chat__composer-combobox textarea").waitFor({ state: "visible" });
        await gateway.waitForRequest("progressCard.get");
        await openChatDetails(page);
        await expect.poll(() => card.isVisible()).toBe(true);
        await expect
          .poll(() => card.textContent())
          .toContain("The task progressed while the card was hidden.");
        await settingsPage.reload();
        await waitForControlUiSettingsTakeover(settingsPage);
        await expect.poll(enabled).toBe(false);

        await showRow.click();
        await expect.poll(enabled).toBe(true);
        await openChatDetails(page);
        await expectVisible(card);
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
