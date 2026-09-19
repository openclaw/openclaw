import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("hides and restores composer progress across tabs and reloads without clearing it", async () => {
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
            {
              role: "user",
              content: [{ type: "text", text: "Check the progress display setting." }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "The task continues whether progress cards are visible or hidden.",
                },
              ],
            },
          ],
          methodResponses: {
            "progressCard.get": { card: cardData },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Progress display preference",
                updatedAt: 1,
              },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const card = page.locator('[data-progress-card-placement="composer"]');
        await expect.poll(() => card.isVisible()).toBe(true);
        await captureUiProof(suite, page, "progress-preference", "01-cards-enabled.png");

        const settingsPage = await context.newPage();
        const settingsGateway = await installMockGateway(settingsPage, { sessionKey });
        await settingsPage.goto(
          `${suite.server.baseUrl}settings/appearance?section=__appearance__#settings-appearance-chat`,
        );
        await waitForControlUiSettingsTakeover(settingsPage);
        const row = (title: string) =>
          settingsPage
            .locator(".settings-row")
            .filter({
              has: settingsPage.locator(".settings-row__title", { hasText: title }),
            })
            .first();
        const showRow = row("Show task progress cards");
        const collapseRow = row("Collapse task progress by default");
        const enabled = () =>
          showRow
            .locator("wa-switch")
            .evaluate((element) => Boolean((element as { checked?: boolean }).checked));
        await expect.poll(enabled).toBe(true);
        await expect.poll(() => showRow.textContent()).not.toContain("Using default:");
        await settingsPage
          .locator("#settings-appearance-chat")
          .evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
        await captureUiProof(suite, settingsPage, "progress-preference", "02-setting-default.png");

        await collapseRow.click();
        await showRow.click();
        await expect.poll(enabled).toBe(false);
        await expect
          .poll(() =>
            collapseRow
              .locator("wa-switch")
              .evaluate((element) => Boolean((element as { disabled?: boolean }).disabled)),
          )
          .toBe(true);
        await expect.poll(() => page.locator(".agent-chat__progress-float").count()).toBe(0);
        await captureUiProof(suite, settingsPage, "progress-preference", "03-setting-disabled.png");
        await captureUiProof(suite, page, "progress-preference", "04-cards-hidden.png");

        const reads = (await gateway.getRequests("progressCard.get")).length;
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            ...cardData,
            revision: 2,
            markdown: "The task progressed while the card was hidden.",
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        expect((await gateway.getRequests("progressCard.get")).length).toBe(reads);
        await page.reload();
        await page.locator(".agent-chat__composer-combobox textarea").waitFor({ state: "visible" });
        expect(await page.locator(".agent-chat__progress-float").count()).toBe(0);
        // The page-owned mock request log restarts on reload.
        expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
        await settingsPage.reload();
        await waitForControlUiSettingsTakeover(settingsPage);
        await expect.poll(enabled).toBe(false);

        await showRow.click();
        await expect.poll(enabled).toBe(true);
        await expect.poll(() => card.isVisible()).toBe(true);
        await expect
          .poll(() => card.textContent())
          .toContain("The task progressed while the card was hidden.");
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
        await settingsPage.close();
      },
    );
  });
});
