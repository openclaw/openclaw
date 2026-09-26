import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Reconnect drafting" });
const attachment = {
  name: "release-notes.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Review the release notes."),
};

suite.define(() => {
  it("keeps Retry clear of native desktop caption buttons", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const script = readFileSync(
        new URL("../../../apps/linux/ui/window-chrome.js", import.meta.url),
        "utf8",
      );
      const css = readFileSync(
        new URL("../../../apps/linux/ui/window-chrome.css", import.meta.url),
        "utf8",
      );
      await page.addInitScript({
        content:
          "window.__TAURI_INTERNALS__={invoke:async()=>({focused:true,fullscreen:false,maximized:false})};(" +
          script +
          ")(" +
          JSON.stringify({ origin: new URL(suite.server.baseUrl).origin, platform: "linux", css }) +
          ");",
      });
      const gateway = await installMockGateway(page);
      await page.goto(suite.server.baseUrl + "chat");
      await waitForControlUiGatewayReady(page);
      const caption = page.getByRole("group", { name: "Window controls" });
      await caption.waitFor();
      await gateway.deferNext("connect");
      await gateway.closeLatest(1012, "synthetic reconnect");
      const retry = page
        .locator(".connection-status-banner")
        .getByRole("button", { name: "Retry now" });
      await retry.waitFor();
      const button = (await retry.boundingBox())!;
      const controls = (await caption.boundingBox())!;
      expect(button.x + button.width).toBeLessThanOrEqual(controls.x);
      const sockets = await gateway.getSocketCount();
      await retry.click();
      await waitForControlUiGatewayReady(page);
      expect(await gateway.getSocketCount()).toBeGreaterThan(sockets);
    });
  });

  it("keeps a new draft and attachment through retry without starting it", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(suite.server.baseUrl + "new");
      await waitForControlUiGatewayReady(page);
      const draft = page.locator(".new-session-page__message");
      await draft.fill("Keep this unsubmitted draft");
      await page.locator(".agent-chat__file-input").setInputFiles(attachment);
      await page.getByRole("button", { name: "Remove release-notes.txt" }).waitFor();
      await draft.focus();
      await gateway.deferNext("connect");
      await gateway.closeLatest(1012, "synthetic reconnect");
      const banner = page.locator(".connection-status-banner");
      await banner.waitFor();
      expect(await draft.isEditable()).toBe(true);
      expect(await draft.evaluate((element) => document.activeElement === element)).toBe(true);
      const start = page.getByRole("button", { name: "Waiting to reconnect", exact: true });
      expect(await start.getAttribute("aria-disabled")).toBe("true");
      expect(await start.getAttribute("disabled")).toBeNull();
      await start.focus();
      expect(await start.evaluate((element) => document.activeElement === element)).toBe(true);
      await start.press("Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await draft.fill("Still my unsubmitted draft");
      await draft.press("Enter");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await page.locator(".shell-connection-status").count()).toBe(0);
      expect(
        await page.locator('[role="status"]').filter({ hasText: "Reconnecting" }).count(),
      ).toBe(1);
      const retry = banner.getByRole("button", { name: "Retry now" });
      expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      const oldSockets = await gateway.getSocketCount();
      await retry.click();
      await waitForControlUiGatewayReady(page);
      expect(await gateway.getSocketCount()).toBeGreaterThan(oldSockets);
      await banner.waitFor({ state: "detached" });
      expect(await draft.inputValue()).toBe("Still my unsubmitted draft");
      expect(await page.getByRole("button", { name: "Remove release-notes.txt" }).count()).toBe(1);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("queues text and attachment offline and sends only after reconnection", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "The previous conversation stays readable." }],
          },
        ],
      });
      await page.goto(suite.server.baseUrl + "chat");
      await waitForControlUiGatewayReady(page);
      await page.getByText("The previous conversation stays readable.", { exact: true }).waitFor();
      await gateway.setOnline(false);
      const banner = page.locator(".connection-status-banner");
      await banner.waitFor();
      const mainBounds = (await page.locator("main").boundingBox())!;
      const bannerBounds = (await banner.boundingBox())!;
      expect(bannerBounds.x).toBe(mainBounds.x);
      expect(bannerBounds.width).toBe(mainBounds.width);
      expect(bannerBounds.height).toBe(70);
      const draft = page.locator(".agent-chat__composer-combobox textarea");
      await draft.fill("Review these notes on reconnect");
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page
          .locator(".agent-chat__composer-status-band")
          .evaluate((element) => getComputedStyle(element).whiteSpace),
      ).toBe("normal");
      await page.locator(".agent-chat__file-input").setInputFiles(attachment);
      await page.getByRole("button", { name: "Remove release-notes.txt" }).waitFor();
      await page.getByRole("button", { name: "Queue message", exact: true }).click();
      await page
        .locator(".chat-queue__item")
        .getByText("Review these notes on reconnect", { exact: true })
        .waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await draft.inputValue()).toBe("");
      expect(await page.locator("main[inert], openclaw-router-outlet[inert]").count()).toBe(0);
      await gateway.deferNext("chat.send");
      await gateway.setOnline(true);
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({
        message: "Review these notes on reconnect",
        attachments: [{ fileName: attachment.name, content: attachment.buffer.toString("base64") }],
      });
      await page.locator(".connection-status-banner").waitFor({ state: "detached" });
      expect(
        await page.getByText("The previous conversation stays readable.", { exact: true }).count(),
      ).toBe(1);
    });
  });
});
