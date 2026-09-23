import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Queued reorder conflict recovery",
  trackBrowserContexts: true,
});

suite.define(() => {
  it("retires a peer-edit conflict after the same reorder succeeds", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page);
    try {
      await page.goto(`${suite.server.baseUrl}chat?session=main`);
      await page.getByRole("button", { name: "Open split view", exact: true }).click();
      const cells = page.locator(".chat-split-view__cell");
      await expect.poll(() => cells.count()).toBe(2);
      const left = cells.first();
      const right = cells.last();
      const composer = left.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await gateway.setOnline(false);
      for (const message of ["QA queued A", "QA queued B", "QA queued C"]) {
        await composer.fill(message);
        await composer.press("Enter");
        await right.locator(".chat-queue__text", { hasText: message }).waitFor();
      }
      const order = () => right.locator(".chat-queue__text").allTextContents();
      const initialOrder = ["QA queued A", "QA queued B", "QA queued C"];
      await expect.poll(order).toEqual(initialOrder);
      await left.locator(".chat-queue__item", { hasText: "QA queued B" }).dblclick();
      const edit = left.locator(".chat-queue__edit-input");
      await edit.waitFor({ state: "visible" });
      await edit.fill("QA unfinished correction B");
      const moveC = right
        .locator(".chat-queue__item", { hasText: "QA queued C" })
        .getByRole("button", { name: "Reorder queued message with the arrow keys", exact: true });
      await moveC.press("ArrowUp");
      const conflict = right.locator(".chat-error", {
        hasText: "Finish or cancel that edit before reordering it.",
      });
      await conflict.waitFor({ state: "visible" });
      await expect.poll(order).toEqual(initialOrder);
      await page.screenshot({ path: `${suite.artifactDir}/reorder-blocked.png`, fullPage: true });

      await left
        .getByRole("button", { name: "Cancel editing and keep the queued message", exact: true })
        .click();
      await expect.poll(() => edit.count()).toBe(0);
      await moveC.press("ArrowUp");
      await expect.poll(order).toEqual(["QA queued A", "QA queued C", "QA queued B"]);

      // Retain the successful action and its visible outcome before the recovery assertion.
      const receipt = {
        queueOrder: await order(),
        errors: await right.locator(".chat-error").allTextContents(),
        openEdits: await page.locator(".chat-queue__edit-input").count(),
        sendRequests: await gateway.getRequests("chat.send"),
      };
      await writeFile(
        `${suite.artifactDir}/reorder-recovery.json`,
        JSON.stringify(receipt, null, 2),
      );
      await page.screenshot({ path: `${suite.artifactDir}/reorder-retried.png`, fullPage: true });
      console.log(JSON.stringify({ artifactDir: suite.artifactDir, ...receipt }));
      expect(receipt.sendRequests).toHaveLength(0);
      expect(receipt.openEdits).toBe(0);
      await expect.poll(() => conflict.count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
