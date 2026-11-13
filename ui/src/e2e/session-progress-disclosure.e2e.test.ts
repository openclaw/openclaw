import type { Page } from "playwright";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { seedChatSettings, splitColumns } from "./chat-layout-fixtures.test-support.ts";

const suite = createChatFlowE2eSuite();

async function installProgressGateway(page: Page, sessionKey: string, canonicalKey = sessionKey) {
  const session = {
    key: canonicalKey,
    sessionId: `session:${sessionKey}`,
    kind: "direct",
    updatedAt: 1,
    hasActiveRun: true,
    activeRunIds: ["progress-run"],
  };
  const card = {
    sessionKey: canonicalKey,
    revision: 1,
    updatedAt: Date.now(),
    steps: [
      { step: "Inspect the conversation", status: "in_progress" },
      { step: "Verify navigation", status: "pending" },
    ],
  };
  return installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
    sessionKey,
    sessionInfo: session,
    sessions: [session],
    inFlightRun: { runId: "progress-run", startedAt: Date.now() },
    methodResponses: {
      "progressCard.get": {
        cases: [{ match: { sessionKey: canonicalKey }, response: { card } }],
      },
    },
  });
}

suite.define(() => {
  it.each(["open", "closed"] as const)(
    "keeps a manually %s Details card after resolving a stored short-name pane through reconnect",
    (choice) =>
      suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        await seedChatSettings(page, suite.server.baseUrl, {
          chatSplitLayout: splitColumns([{ key: "agent:main:main" }, { key: "notes" }], 0),
        });
        const gateway = await installProgressGateway(page, "notes", "agent:main:notes");
        const pane = page
          .locator(".chat-split-view__cell")
          .nth(1)
          .locator('openclaw-chat-pane[aria-hidden="false"]');
        const card = pane.locator('[data-progress-card-placement="details"]');
        const open = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
        const paneKey = () =>
          pane.evaluate((element) => (element as HTMLElement & { sessionKey: string }).sessionKey);
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator(".agent-chat__composer-combobox textarea").first().waitFor();
        // Short-key resolution closes the popover, so activate before opening it.
        await pane.locator(".agent-chat__composer-combobox textarea").click();
        await expect.poll(paneKey).toBe("agent:main:notes");
        await openChatDetails(pane);
        const retainedCard = await card.elementHandle();
        await gateway.setOnline(false);
        await pane.locator(".agent-chat__input--offline").waitFor({ state: "visible" });
        // Disconnect clears selected-session metadata and closes the popover.
        await openChatDetails(pane);
        const summary = card.locator("summary");
        await summary.waitFor({ state: "visible" });
        expect(await pane.locator(".chat-details:visible").isVisible()).toBe(true);
        const initialOpen = await open();
        await summary.focus();
        expect(await summary.evaluate((element) => document.activeElement === element)).toBe(true);
        await summary.press("Enter");
        await expect.poll(open).toBe(!initialOpen);
        if (initialOpen === (choice === "open")) {
          await summary.press("Space");
        }
        await expect.poll(open).toBe(choice === "open");
        await gateway.setOnline(true);
        await pane.locator(".agent-chat__input--offline").waitFor({ state: "hidden" });
        expect(await retainedCard!.evaluate((element) => element.isConnected)).toBe(true);
        await openChatDetails(pane);
        expect(await open()).toBe(choice === "open");
        expect(await paneKey()).toBe("agent:main:notes");
        await retainedCard!.dispose();
      }),
  );
});
