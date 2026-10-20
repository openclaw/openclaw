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

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("hides and restores Details progress across tabs and reloads without clearing it", async () => {
    const sessionKey = "agent:main:progress-preference";
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { width: 1280, height: 900 } },
      async ({ page, context }) => {
        const cardData = {
          sessionKey,
          revision: 1,
          updatedAt: Date.now(),
          steps: [
            { step: "Inspect existing settings", status: "completed" },
            { step: "Verify the new preference", status: "in_progress" },
          ],
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
        await expect.poll(() => card.isVisible()).toBe(true);

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
        await expect.poll(() => card.count()).toBe(0);

        const reads = (await gateway.getRequests("progressCard.get")).length;
        const progressed = "The task progressed while the card was hidden.";
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            ...cardData,
            revision: 2,
            markdown: progressed,
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        expect((await gateway.getRequests("progressCard.get")).length).toBe(reads);
        await page.reload();
        await page.locator(".agent-chat__composer-combobox textarea").waitFor({ state: "visible" });
        expect(await card.count()).toBe(0);
        // The page-owned mock request log restarts on reload.
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
        await settingsPage.reload();
        await waitForControlUiSettingsTakeover(settingsPage);
        await expect.poll(enabled).toBe(false);

        await showRow.click();
        await expect.poll(enabled).toBe(true);
        await openChatDetails(page);
        await expect.poll(() => card.isVisible()).toBe(true);
        await expect.poll(() => card.textContent()).toContain(progressed);
        expect(await card.getAttribute("open")).toBeNull();
        const persisted = await settingsPage.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        );
        expect(persisted.chatCollapseTaskProgress).toBe(true);
        expect(persisted).not.toHaveProperty("chatShowTaskProgress");
        expect(await gateway.getRequests("progressCard.put")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        expect(await settingsGateway.getRequests("config.patch")).toHaveLength(0);
      },
    );
  });
});
