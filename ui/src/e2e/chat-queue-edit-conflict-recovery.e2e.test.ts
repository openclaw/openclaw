import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { exactButton, newChatPage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Queued edit conflict recovery",
  trackBrowserContexts: true,
});

suite.define(() => {
  it.each(["resolved-edit", "unresolved-removal"] as const)(
    "keeps error feedback current after opening a queued editor (%s)",
    async (scenario) => {
      const page = await newChatPage(suite);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat?session=main`);
      await selectChatLayoutAction(page, "Open split view");
      const cells = page.locator(".chat-split-view__cell");
      await expect.poll(() => cells.count()).toBe(2);
      const left = cells.first();
      const right = cells.last();
      const leftComposer = left.locator(".agent-chat__composer-combobox textarea");
      const rightComposer = right.locator(".agent-chat__composer-combobox textarea");
      await leftComposer.waitFor({ state: "visible" });
      await gateway.setOnline(false);
      for (const message of ["QA queued B", "QA queued C"]) {
        await leftComposer.fill(message);
        await leftComposer.press("Enter");
        await right.locator(".chat-queue__text", { hasText: message }).waitFor();
      }
      await rightComposer.fill("QA separate composer draft");
      await left.locator(".chat-queue__item", { hasText: "QA queued B" }).dblclick();
      const leftEdit = left.locator(".chat-queue__edit-input");
      await leftEdit.waitFor({ state: "visible" });
      await leftEdit.fill("QA unfinished correction B");
      const peerRow = right.locator(".chat-queue__item", { hasText: "QA queued B" });
      const conflict = right.locator(".chat-error", {
        hasText:
          scenario === "resolved-edit"
            ? "Finish or cancel that edit before editing it here."
            : "Finish or cancel that edit before removing it.",
      });
      if (scenario === "resolved-edit") {
        await peerRow.dblclick();
      } else {
        await peerRow.locator(".chat-queue__remove").click();
      }
      await conflict.waitFor({ state: "visible" });

      if (scenario === "resolved-edit") {
        await exactButton(left, "Cancel editing and keep the queued message").click();
        await expect.poll(() => leftEdit.count()).toBe(0);
        await peerRow.dblclick();
      } else {
        await right.locator(".chat-queue__item", { hasText: "QA queued C" }).dblclick();
      }
      const rightEdit = right.locator(".chat-queue__edit-input");
      await rightEdit.waitFor({ state: "visible" });
      expect({
        editedText: await rightEdit.inputValue(),
        composerDraft: await rightComposer.inputValue(),
        queueRows: await right.locator(".chat-queue__item").count(),
        openEdits: await page.locator(".chat-queue__edit-input").count(),
        pageErrors,
        sendRequests: await gateway.getRequests("chat.send"),
      }).toEqual({
        editedText: scenario === "resolved-edit" ? "QA queued B" : "QA queued C",
        composerDraft: "QA separate composer draft",
        queueRows: 2,
        openEdits: scenario === "resolved-edit" ? 1 : 2,
        pageErrors: [],
        sendRequests: [],
      });
      await expect.poll(() => conflict.count()).toBe(scenario === "resolved-edit" ? 0 : 1);
    },
  );
});
