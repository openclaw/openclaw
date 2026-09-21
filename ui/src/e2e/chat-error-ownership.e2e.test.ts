import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat terminal error ownership" });
suite.define(() => {
  it("moves a live diagnostic into durable history, preserving partial output and separate errors after reconnect", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const diagnostic =
          "Request failed.\nFile /workspace/example.txt could not be read.\npassword=synthetic-password";
        const safeDiagnostic = diagnostic.replace("synthetic-password", "[redacted]");
        const gateway = await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".agent-chat__input textarea").fill("Review the example project");
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = asNullableRecord(send.params)?.idempotencyKey;
        if (typeof runId !== "string") {
          throw new Error("chat.send did not carry its run identity");
        }
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "delta",
          deltaText: "I checked the first file.",
          message: {
            role: "assistant",
            content: "I checked the first file.",
            __openclaw: { id: "partial", seq: 2, runId },
          },
        });
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "error",
          errorMessage: diagnostic,
        });
        await page.locator(".agent-chat__composer-notices .chat-error").waitFor();
        const rows = [
          {
            role: "user",
            content: "Review the example project",
            __openclaw: { id: "prompt", seq: 1, runId },
          },
          {
            role: "assistant",
            content: "I checked the first file.",
            __openclaw: { id: "partial", seq: 2, runId },
          },
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: diagnostic,
            content: "Error: " + diagnostic,
            __openclaw: { id: "error", seq: 3, runId },
          },
        ];
        await gateway.setHistoryMessages(rows);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          runId,
          hasActiveRun: false,
          messageId: "partial",
          messageSeq: 2,
          message: rows[1],
        });
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          runId,
          hasActiveRun: false,
          messageId: "error",
          messageSeq: 3,
          message: rows[2],
        });
        await expect.poll(() => page.locator(".chat-bubble .chat-error").count()).toBe(1);
        expect(await page.locator(".agent-chat__composer-notices .chat-error").count()).toBe(0);
        // Reconnect recovers the same durable diagnostic rather than reviving its banner.
        await gateway.closeLatest();
        await expect.poll(async () => await gateway.getSocketCount()).toBeGreaterThan(1);
        await expect.poll(() => page.locator(".chat-bubble .chat-error").count()).toBe(1);
        expect(await page.locator(".chat-error").count()).toBe(1);
        expect(await page.getByText("I checked the first file.", { exact: true }).count()).toBe(1);
        const alert = page.locator(".chat-error");
        await alert.locator("summary").click();
        expect(await alert.getByLabel("Error details", { exact: true }).textContent()).toBe(
          "Error: " + safeDiagnostic,
        );
        await alert.getByRole("button", { name: "Copy error", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe("Error: " + safeDiagnostic);
        await page.setViewportSize({ width: 393, height: 852 });
        await expect
          .poll(() => alert.evaluate((node) => node.scrollWidth <= node.clientWidth))
          .toBe(true);
        // A second diagnostic from this same run remains distinct.
        const second = "Error: A separate upload failed.";
        await gateway.setHistoryMessages([
          ...rows,
          {
            ...rows[2],
            errorMessage: second,
            content: second,
            __openclaw: { id: "second-error", seq: 4, runId },
          },
        ]);
        await gateway.closeLatest();
        await expect.poll(() => page.locator(".chat-bubble .chat-error").count()).toBe(2);
        expect(await page.locator(".chat-error").count()).toBe(2);
      },
    );
  });
});
