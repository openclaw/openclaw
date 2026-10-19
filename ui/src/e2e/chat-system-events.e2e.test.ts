import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "System event disclosure",
  startServerBeforeBrowser: true,
});
const timestamp = Date.UTC(2026, 9, 16, 10);
function message(role: string, content: string, id: string) {
  return { role, content, timestamp, __openclaw: { id } };
}
function recovery(id: string, text: string) {
  return {
    ...message("user", text, id),
    provenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
  };
}
const events = [
  recovery("recovery-1", "Gateway restarted. The conversation has been restored."),
  {
    ...message("assistant", "", "fallback-1"),
    openclawDeliveryMirror: {
      kind: "model-fallback",
      runId: "demo-run",
      fromModel: "Primary",
      toModel: "Backup",
      reason: "capacity",
    },
  },
  {
    ...message(
      "custom",
      "Two progress updates could not be delivered. Review the retained updates before continuing.",
      "delivery-1",
    ),
    customType: "session-send-recovery-blocked",
  },
  recovery("recovery-2", "The workspace connection is available again."),
  {
    ...message("assistant", "", "fallback-2"),
    openclawDeliveryMirror: {
      kind: "model-fallback",
      runId: "demo-run",
      phase: "restored",
      fromModel: "Backup",
      toModel: "Primary",
    },
  },
  recovery("recovery-3", "Recovery checks finished. Your conversation is ready."),
];
const history = [
  message("user", "Please prepare a short launch checklist.", "user-1"),
  ...events,
  message(
    "assistant",
    "The checklist is ready: confirm the release, review the rollout, and share the announcement.",
    "assistant-1",
  ),
];

suite.define(() => {
  it("keeps operational history quiet, readable, keyboard accessible and responsive", async () => {
    await suite.withPage(
      { viewport: { width: 1100, height: 900 }, colorScheme: "light" },
      async ({ page }) => {
        await installMockGateway(page, { historyMessages: history });
        await page.goto(suite.server.baseUrl + "chat");
        const disclosure = page.locator(".chat-system-events");
        const summary = disclosure.locator("summary");
        await summary.waitFor();
        expect(await summary.textContent()).toContain("6 system events");
        expect(await summary.textContent()).toContain("Updates not delivered");
        expect(await disclosure.getAttribute("open")).toBeNull();
        expect(await disclosure.locator(".chat-notice").count()).toBe(0);
        const surface = page.locator(".chat-thread");
        const prompt = page.getByText("Please prepare a short launch checklist.", { exact: true });
        const answer = page.getByText(
          "The checklist is ready: confirm the release, review the rollout, and share the announcement.",
          { exact: true },
        );
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
              offset:
                labelRect.left + labelRect.width / 2 - summaryRect.left - summaryRect.width / 2,
              lineWidths: lines.map((line) => line.getBoundingClientRect().width),
            };
          });
          expect(Math.abs(geometry.offset)).toBeLessThan(1);
          expect(geometry.lineWidths).toHaveLength(2);
          expect(Math.abs(geometry.lineWidths[0]! - geometry.lineWidths[1]!)).toBeLessThan(1);
        };
        await expectCenteredSummary();
        const dir = createControlUiE2eArtifactDir("system-events-after");
        const capture = async (filename: string, content = [summary]) => {
          const frame = await takeControlUiScreenshotFrame(page, surface, content, {
            animations: "disabled",
            elements: [surface],
          });
          writeFileSync(path.join(dir, filename), frame.elements[0]!.png);
        };
        await capture("after.png", [prompt, summary, answer]);
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
          "Two progress updates could not be delivered. Review the retained updates before continuing.",
          "System · gateway restartedThe workspace connection is available again.",
          "Returned to selected model: Backup → Primary",
          "System · gateway restartedRecovery checks finished. Your conversation is ready.",
        ]);
        await capture("expanded.png");
        await summary.focus();
        await page.keyboard.press("Space");
        await expect.poll(() => disclosure.getAttribute("open")).toBeNull();
        await page.setViewportSize({ width: 390, height: 844 });
        await summary.scrollIntoViewIfNeeded();
        expect(await summary.locator(".chat-system-events__warning").isVisible()).toBe(true);
        expect(
          await summary.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await expectCenteredSummary();
        await capture("narrow.png");
      },
    );
  });

  it("retains an open disclosure as more events arrive and exposes matching search results", async () => {
    await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
      const initial = history.slice(0, -1);
      const gateway = await installMockGateway(page, { historyMessages: initial });
      await page.goto(suite.server.baseUrl + "chat");
      const disclosure = page.locator(".chat-system-events");
      await disclosure.locator("summary").click();
      await expect.poll(() => disclosure.locator(".chat-notice").count()).toBe(4);
      const appended = recovery("recovery-4", "A new recovery event arrived.");
      await gateway.setHistoryMessages([...initial, appended]);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "agent:main:main",
        message: appended,
        messageId: "recovery-4",
        messageSeq: 9,
        session: {
          key: "agent:main:main",
          kind: "direct",
          status: "done",
          updatedAt: timestamp + 1,
        },
      });
      await expect
        .poll(() => disclosure.locator("summary").textContent())
        .toContain("7 system events");
      expect(await disclosure.getAttribute("open")).not.toBeNull();
      expect(
        await disclosure.getByText("A new recovery event arrived.", { exact: true }).isVisible(),
      ).toBe(true);
      await page.keyboard.press("ControlOrMeta+f");
      const search = page.getByRole("textbox", { name: "Search messages", exact: true });
      await search.fill("workspace connection");
      await expect.poll(() => disclosure.count()).toBe(0);
      expect(
        await page
          .getByText("The workspace connection is available again.", { exact: true })
          .isVisible(),
      ).toBe(true);
    });
  });
});
