import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "System event disclosure",
  startServerBeforeBrowser: true,
});
const pageOptions = { viewport: { width: 1100, height: 900 }, colorScheme: "light" as const };
const timestamp = Date.UTC(2026, 9, 16, 10);
const promptText = "Please prepare a short launch checklist.";
const answerText =
  "The checklist is ready: confirm the release, review the rollout, and share the announcement.";
const warningText =
  "Two progress updates could not be delivered. Review the retained updates before continuing.";
const connectedText = "The workspace connection is available again.";
function message(role: string, content: string, id: string) {
  return { role, content, timestamp, __openclaw: { id } };
}
function recovery(id: string, text: string) {
  return {
    ...message("user", text, id),
    provenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
  };
}
function fallback(id: string, restored = false) {
  return {
    ...message("assistant", "", id),
    openclawDeliveryMirror: {
      kind: "model-fallback",
      runId: "demo-run",
      fromModel: restored ? "Backup" : "Primary",
      toModel: restored ? "Primary" : "Backup",
      ...(restored ? { phase: "restored" } : { reason: "capacity" }),
    },
  };
}
const events = [
  recovery("recovery-1", "Gateway restarted. The conversation has been restored."),
  fallback("fallback-1"),
  {
    ...message("custom", warningText, "delivery-1"),
    customType: "session-send-recovery-blocked",
  },
  recovery("recovery-2", connectedText),
  fallback("fallback-2", true),
  recovery("recovery-3", "Recovery checks finished. Your conversation is ready."),
];
const history = [
  message("user", promptText, "user-1"),
  ...events,
  message("assistant", answerText, "assistant-1"),
];

suite.define(() => {
  it.each([false, true])(
    "appends events without losing disclosure state (grouped=%s)",
    async (grouped) => {
      await suite.withPage(
        grouped ? { viewport: pageOptions.viewport } : pageOptions,
        async ({ page }) => {
          const initial = grouped ? history.slice(0, -1) : [history[0]!, events[2]!];
          const gateway = await installMockGateway(page, { historyMessages: initial });
          await page.goto(suite.server.baseUrl + "chat");
          const disclosure = page.locator(".chat-system-events");
          const summary = disclosure.locator("summary");
          const warning = page.locator(".chat-thread").getByText(warningText, { exact: true });
          if (grouped) {
            await summary.click();
            await expect.poll(() => disclosure.locator(".chat-notice").count()).toBe(4);
          } else {
            await page.getByText(promptText, { exact: true }).waitFor();
            await warning.waitFor();
            expect(await disclosure.count()).toBe(0);
            expect(await warning.isVisible()).toBe(true);
            await page.reload();
            await warning.waitFor();
            expect(await disclosure.count()).toBe(0);
          }
          const messageId = grouped ? "recovery-4" : "recovery-next";
          const appended = recovery(
            messageId,
            grouped ? "A new recovery event arrived." : connectedText,
          );
          await gateway.setHistoryMessages([...initial, appended]);
          await gateway.emitGatewayEvent("session.message", {
            sessionKey: "agent:main:main",
            message: appended,
            messageId,
            messageSeq: grouped ? 9 : 3,
            ...(grouped
              ? {
                  session: {
                    key: "agent:main:main",
                    kind: "direct",
                    status: "done",
                    updatedAt: timestamp + 1,
                  },
                }
              : {}),
          });
          await expect
            .poll(() => summary.textContent())
            .toContain(grouped ? "7 system events" : "2 system events");
          if (grouped) {
            expect(await disclosure.getAttribute("open")).not.toBeNull();
          } else {
            expect(await disclosure.getAttribute("open")).toBeNull();
            expect(await disclosure.locator(".chat-system-events__warning").isVisible()).toBe(true);
            await summary.click();
            await warning.waitFor();
            expect(await warning.isVisible()).toBe(true);
          }
          expect(await disclosure.getByText(appended.content, { exact: true }).isVisible()).toBe(
            true,
          );
          if (grouped) {
            await page.keyboard.press("ControlOrMeta+f");
            await page
              .getByRole("textbox", { name: "Search messages", exact: true })
              .fill("workspace connection");
            await expect.poll(() => disclosure.count()).toBe(0);
            await expect
              .poll(() => page.getByText(connectedText, { exact: true }).isVisible())
              .toBe(true);
          }
        },
      );
    },
  );

  it("keeps operational history quiet, readable, keyboard accessible and responsive", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await installMockGateway(page, { historyMessages: history });
      await page.goto(suite.server.baseUrl + "chat");
      const disclosure = page.locator(".chat-system-events");
      const summary = disclosure.locator("summary");
      await summary.waitFor();
      expect(await summary.textContent()).toContain("6 system events");
      expect(await summary.textContent()).toContain("Updates not delivered");
      expect(await disclosure.getAttribute("open")).toBeNull();
      expect(await disclosure.locator(".chat-notice").count()).toBe(0);
      const prompt = page.getByText(promptText, { exact: true });
      const answer = page.getByText(answerText, { exact: true });
      await answer.waitFor();
      expect(await prompt.isVisible()).toBe(true);
      const expectCenteredSummary = async () => {
        const geometry = await summary.evaluate((element) => {
          const summaryRect = element.getBoundingClientRect();
          const labelRect = element
            .querySelector(".chat-system-events__label")!
            .getBoundingClientRect();
          const lines = Array.from(element.querySelectorAll(".chat-system-events__line"));
          return {
            offset: labelRect.left + labelRect.width / 2 - summaryRect.left - summaryRect.width / 2,
            lineWidths: lines.map((line) => line.getBoundingClientRect().width),
          };
        });
        expect(Math.abs(geometry.offset)).toBeLessThan(1);
        expect(geometry.lineWidths).toHaveLength(2);
        expect(Math.abs(geometry.lineWidths[0]! - geometry.lineWidths[1]!)).toBeLessThan(1);
      };
      await expectCenteredSummary();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => disclosure.locator(".chat-notice").count()).toBe(4);
      expect(await disclosure.getAttribute("open")).not.toBeNull();
      const contents = await disclosure
        .locator(".chat-system-events__body > [data-chat-row-key]")
        .allTextContents();
      expect(contents.map((text) => text.replace(/\s+/gu, " ").trim())).toEqual([
        "System · gateway restartedGateway restarted. The conversation has been restored.",
        "Model fallback: Primary → BackupReason: capacity",
        warningText,
        "System · gateway restartedThe workspace connection is available again.",
        "Returned to selected model: Backup → Primary",
        "System · gateway restartedRecovery checks finished. Your conversation is ready.",
      ]);
      await summary.focus();
      await page.keyboard.press("Space");
      await expect.poll(() => disclosure.getAttribute("open")).toBeNull();
      await page.setViewportSize({ width: 390, height: 844 });
      await summary.scrollIntoViewIfNeeded();
      expect(await summary.locator(".chat-system-events__warning").isVisible()).toBe(true);
      expect(await summary.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await expectCenteredSummary();
    });
  });
});
