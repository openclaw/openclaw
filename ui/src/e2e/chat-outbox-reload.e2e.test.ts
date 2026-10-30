import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import { readOutboxQueue } from "./chat-outbox-payloads.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const retainedText = "Keep this pending message and its attachment during an update.";
const sessionKey = "agent:main:pending-update";
const file = {
  name: "pending-note.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Exact synthetic pending attachment bytes."),
};

suite.define(() => {
  it("holds automatic stale-build recovery for a rejected first turn kept only in memory", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
      async ({ page }) => {
        await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
        await page.addInitScript(() => {
          const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
            ?.value as Storage["setItem"];
          Storage.prototype.setItem = function (key: string, value: string) {
            // Reject pending-message payloads, not sessionStorage itself or saved drafts.
            if (key.startsWith("openclaw.control.chatComposer.v4:") && value.includes('"queue":')) {
              throw new DOMException("Synthetic pending payload quota", "QuotaExceededError");
            }
            return setItem.call(this, key, value);
          };
        });
        const gateway = await installMockGateway(page, {
          sessions: [{ key: sessionKey, label: "Pending input", kind: "direct", updatedAt: 1 }],
        });
        await page.goto(suite.server.baseUrl + "new?agent=main");
        await page.locator(".new-session-page__message").fill(retainedText);
        await page.locator(".agent-chat__file-input").setInputFiles(file);
        await page.getByText(file.name, { exact: true }).first().waitFor();
        const oldAssets = /\/assets\/private-composer-recovery-content-[^/]+\.js(?:\?.*)?$/u;
        expect(
          await page.evaluate(() =>
            performance
              .getEntriesByType("resource")
              .some((entry) => entry.name.includes("private-composer-recovery-content-")),
          ),
        ).toBe(false);
        const recoveryReady = page.waitForResponse(
          (response) => oldAssets.test(response.url()) && response.status() === 200,
        );
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session", exact: true }).click();
        const created = await gateway.waitForRequest("sessions.create");
        expect(created.params).toMatchObject({
          message: retainedText,
          attachments: [{ fileName: file.name, content: file.buffer.toString("base64") }],
        });
        await gateway.resolveDeferred("sessions.create", {
          key: sessionKey,
          runStarted: false,
          runError: { code: "INVALID_REQUEST", message: "Synthetic initial turn rejected" },
        });
        await waitForCommittedChatRoute(page);
        const pending = page.locator(".chat-group.user", { hasText: retainedText });
        await pending.getByText("Not sent", { exact: true }).waitFor();
        expect(await readOutboxQueue(page)).toEqual([]);
        // A replaced build no longer serves unrequested old hashed assets.
        await (await recoveryReady).finished();
        await page.route(oldAssets, (route) =>
          route.fulfill({ status: 404, body: "Old build asset removed" }),
        );
        expect(
          await page.evaluate(() => {
            sessionStorage.setItem("qa.reload-storage-control", "works");
            return sessionStorage.getItem("qa.reload-storage-control");
          }),
        ).toBe("works");
        let reloads = 0;
        page.on("domcontentloaded", () => {
          reloads += 1;
        });
        await gateway.setOnline(false);
        await gateway.deferNext("connect");
        const previous = (await gateway.getRequests("connect")).length;
        await gateway.setOnline(true);
        await gateway.waitForRequest("connect", { after: previous });
        await page.clock.install();
        const navigation = new Promise<"reloaded">((resolve) => {
          page.once("domcontentloaded", () => resolve("reloaded"));
        });
        await gateway.rejectDeferred("connect", {
          code: "UNAVAILABLE",
          message: "protocol mismatch: Control UI updated; reload this page to continue",
          details: {
            code: "PROTOCOL_MISMATCH",
            gatewayBuildId: "pending-input-replacement-build",
            reloadRequired: true,
          },
          retryable: false,
        });
        const refresh = page.getByRole("button", { name: /Server updated/u });
        const blocked = page.getByText(
          "A pending message is only saved in this tab. Keep this tab open until it is sent, or copy it before discarding it and reloading.",
          { exact: true },
        );
        const outcome = await Promise.race([
          navigation,
          (async () => {
            // Exercise the automatic build-recovery timer before requesting Refresh.
            await page.clock.runFor(2001).catch((error: unknown) => {
              if (reloads === 0) {
                throw error;
              }
            });
            await refresh.click();
            await blocked.waitFor();
            return "held" as const;
          })(),
        ]);
        expect(outcome, "automatic document recovery must not drop the only pending copy").toBe(
          "held",
        );
        expect(reloads).toBe(0);
        await pending.getByText(file.name, { exact: true }).first().waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        const review = page.getByRole("button", { name: "Review pending input", exact: true });
        const dialog = page.locator('openclaw-modal-dialog[label="Unsent pending message"]');
        await review.press("Enter");
        await dialog.waitFor();
        const keep = dialog.getByRole("button", { name: "Keep in this tab", exact: true });
        await expect
          .poll(() => keep.evaluate((button) => button === document.activeElement))
          .toBe(true);
        await keep.press("Escape");
        await dialog.waitFor({ state: "detached" });
        expect(reloads).toBe(0);
        await pending.waitFor();
        await refresh.click();
        await review.click();
        await dialog.waitFor();
        expect(
          await dialog.getByRole("textbox", { name: "Message text", exact: true }).inputValue(),
        ).toBe(retainedText);
        await dialog.getByRole("button", { name: "Copy text", exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(retainedText);
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          dialog.getByRole("button", { name: "Download pending-note.txt", exact: true }).click(),
        ]);
        expect(download.suggestedFilename()).toBe(file.name);
        expect(await readControlUiE2eDownload(download)).toEqual(file.buffer);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            dialog.locator("section.exec-approval-card"),
            [dialog.getByRole("textbox", { name: "Message text", exact: true }), keep],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "pending-recovery-after.png"), frame.png);
        }
        await keep.click();
        await dialog.waitFor({ state: "detached" });
        expect(reloads).toBe(0);
        await pending.waitFor();
        await refresh.click();
        await review.click();
        // The next document represents the replacement build, whose assets are available.
        await page.unroute(oldAssets);
        const reloaded = page.waitForEvent("domcontentloaded");
        await dialog
          .getByRole("button", { name: "Discard local copy and refresh", exact: true })
          .click();
        await reloaded;
        expect(reloads).toBe(1);
        expect(await pending.count()).toBe(0);
      },
    );
  });
});
