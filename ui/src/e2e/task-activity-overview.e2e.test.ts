import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createTaskActivityOverviewFixture } from "../test-helpers/task-activity-overview-fixture.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Task activity overview" });

suite.define(() => {
  it.each([
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])("keeps dense Review activity compact and keyboard-inspectable on $name", async (viewport) => {
    const artifactDir = createControlUiE2eArtifactDir(`task-feed-redesign-${viewport.name}`);
    await suite.withPage({ viewport, timezoneId: "UTC" }, async ({ page }) => {
      const fixture = createTaskActivityOverviewFixture();
      // Keep the completed task's timestamps deterministic for the captured details.
      await page.clock.setFixedTime(new Date(Date.UTC(2026, 8, 18, 12, 1, 5)));
      const gateway = await installMockGateway(page, {
        sessionKey: fixture.sessionKey,
        historyMessages: [{ role: "assistant", content: "The child review is ready to inspect." }],
        methodResponses: {
          "tasks.list": { tasks: [fixture.task] },
          "tasks.history": fixture.history,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await openChatSidePanelType(page, "Tasks");
      const rail = page.locator(".chat-tasks-rail");
      await rail.getByRole("button", { name: "Finished (1)" }).click();
      expect(await page.locator(`[data-subagent-task-id="${fixture.task.id}"]`).count()).toBe(0);
      await rail.locator(`[data-task-id="${fixture.task.id}"]`).click();
      const inspector = page.locator("[data-task-detail-panel]");
      const group = inspector.locator("details.chat-task-feed__tool-group");
      const summary = group.locator(":scope > summary");
      await summary.waitFor({ state: "visible" });
      expect(await group.count()).toBe(1);
      expect((await gateway.getRequests("tasks.history")).at(-1)?.params).toEqual({
        taskId: fixture.task.id,
        limit: 100,
      });
      expect(await group.getAttribute("open")).toBeNull();

      // The panel normally follows the transcript tail. Capture its overview from
      // the top, without screenshotting a synthetic standalone replacement.
      const scrollport = inspector.locator(".chat-task-detail__content");
      await scrollport.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              element.scrollTop = 0;
              requestAnimationFrame(() => resolve());
            });
          }),
      );
      await expect.poll(() => scrollport.evaluate((element) => element.scrollTop)).toBe(0);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: path.join(artifactDir, "overview-collapsed.png") });
      await inspector.screenshot({ path: path.join(artifactDir, "review-panel-collapsed.png") });
      const overview = await summary.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        text: element.textContent ?? "",
      }));
      await writeFile(
        path.join(artifactDir, "overview-measurements.json"),
        JSON.stringify(
          {
            viewport,
            summaryHeight: overview.height,
            summaryCharacters: overview.text.length,
            calls: fixture.calls.length,
            execCalls: fixture.calls.filter((call) => call.name === "exec").length,
            authoritativeFailures: fixture.calls
              .filter((call) => call.status === "failed")
              .map((call) => call.id),
          },
          null,
          2,
        ),
      );

      // Soft checks allow all evidence and keyboard/order assertions to run before
      // reporting the original regression. Captures always precede these checks.
      expect
        .soft(overview.height, "Collapsed direct summary must not become a transcript")
        .toBeLessThanOrEqual(100);
      expect
        .soft(overview.text, "Raw commands belong behind disclosure")
        .not.toContain("node --input-type=module");
      expect.soft(overview.text).not.toContain("/workspace/synthetic-review");
      expect.soft(overview.text).not.toContain("Routine poll");
      expect.soft(overview.text).not.toContain("synthetic-review-poll");
      expect
        .soft(overview.text, "Two authoritative failures must be visible without expanding")
        .toMatch(/\b2 failed\b|\bfailed\s*[:×]\s*2\b/i);
      expect
        .soft(
          await scrollport.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        )
        .toBe(true);

      await summary.focus();
      expect(await summary.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => group.getAttribute("open")).not.toBeNull();
      const rows = group.locator(".chat-task-feed__calls .chat-task-feed__tool-line--full");
      const commands = await rows.locator("code").allTextContents();
      expect(commands).toHaveLength(fixture.calls.length);
      // Every raw operation survives expansion in source order, including the
      // hidden routine poll and operations with no recorded outcome.
      for (const [index, call] of fixture.calls.entries()) {
        expect.soft(commands[index], call.id).toContain(call.raw);
      }
      const failed = await group
        .locator(".chat-task-feed__calls .chat-task-feed__error code")
        .allTextContents();
      expect(failed).toEqual(
        fixture.calls.filter((call) => call.status === "failed").map((call) => call.raw),
      );
      await scrollport.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: path.join(artifactDir, "overview-expanded.png") });
      await inspector.screenshot({ path: path.join(artifactDir, "review-panel-expanded.png") });
      const failedRow = group.locator("details.chat-task-feed__error").first();
      const commandSummary = failedRow.locator(":scope > summary");
      expect(await failedRow.locator("pre").isVisible()).toBe(false);
      await commandSummary.focus();
      await page.keyboard.press("Enter");
      await failedRow.locator("pre").waitFor({ state: "visible" });
      expect(await failedRow.locator("code").textContent()).toBe(
        fixture.calls.find((call) => call.status === "failed")?.raw,
      );
      await page.screenshot({ path: path.join(artifactDir, "command-expanded.png") });
      await inspector.screenshot({ path: path.join(artifactDir, "review-panel-command.png") });
      await commandSummary.press("Space");
      await failedRow.locator("pre").waitFor({ state: "hidden" });
      await summary.focus();
      await page.keyboard.press("Space");
      await expect.poll(() => group.getAttribute("open")).toBeNull();
      expect(await summary.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await group.locator(".chat-task-feed__calls").isVisible()).toBe(false);
    });
  });
});
