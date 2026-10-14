import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI uploads policy" });
suite.define(() => {
  it("refreshes live upload controls, preserves attached drafts, and still sends text", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      let uploadsEnabled = true;
      const gateway = await installMockGateway(page);
      await page.route("**/control-ui-config.json", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ...createControlUiMockBootstrapConfig(), uploadsEnabled }),
        }),
      );
      const artifacts = createControlUiE2eArtifactDir("uploads-policy");
      await page.goto(`${suite.server.baseUrl}chat`);
      const textarea = page.locator(".agent-chat__composer-combobox textarea").first();
      await textarea.waitFor({ state: "visible" });
      await textarea.fill("Review this draft");
      const input = page.locator(".agent-chat__file-input").first();
      await input.setInputFiles({
        name: "draft-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic review notes"),
      });
      await page.locator(".chat-attachment-file__name", { hasText: "draft-notes.txt" }).waitFor();
      await page.locator(".agent-chat__input-btn--attach").first().click();
      await page
        .locator('.agent-chat__attach-menu-option[value="file"]')
        .first()
        .waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifacts, "before.png"), animations: "disabled" });
      uploadsEnabled = false;
      await gateway.emitGatewayEvent("config.changed", { hash: "uploads-disabled" });
      await page.locator(".agent-chat__file-input").waitFor({ state: "detached" });
      expect(await page.locator(".agent-chat__attach-menu-option").count()).toBe(0);
      await page.screenshot({ path: path.join(artifacts, "after.png"), animations: "disabled" });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("File and image uploads are disabled.").first().waitFor();
      expect(await textarea.inputValue()).toBe("Review this draft");
      expect(
        await page.locator(".chat-attachment-file__name", { hasText: "draft-notes.txt" }).count(),
      ).toBe(1);
      await page.getByRole("button", { name: "Remove draft-notes.txt", exact: true }).click();
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({ message: "Review this draft" });
      expect(request.params).not.toHaveProperty("attachments");
    });
  });
});
