import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Gateway queued input Steer",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
suite.define(() => {
  it("promotes original server custody without losing the draft or resending the message", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const sessionId = "session:" + sessionKey;
        const row = {
          key: sessionKey,
          sessionId,
          displayName: "Task list review",
          hasActiveRun: true,
          activeRunIds: ["active-review"],
          effectiveQueueMode: "steer",
          status: "running",
          updatedAt: 100,
        };
        const queued = {
          id: "layout-input",
          runId: "original-layout-run",
          acceptedAt: 101,
          state: "queued",
          queued: true,
          message: {
            role: "user",
            content: "Use a compact layout, but keep the group headings readable.",
          },
        };
        const history = {
          sessionId,
          sessionInfo: row,
          messages: [
            {
              role: "user",
              content: "Review the task list and its keyboard controls.",
              timestamp: 100,
              __openclaw: { id: "request", seq: 1 },
            },
            {
              role: "assistant",
              content: "I’m checking spacing, action alignment, and keyboard navigation.",
              timestamp: 101,
              __openclaw: { id: "response", seq: 2 },
            },
          ],
          inFlightRun: {
            runId: "active-review",
            text: "Reviewing the layout and existing controls.",
          },
          pendingInputs: { items: [queued], total: 1, queuedCount: 1 },
          inputReceipts: [{ runId: queued.runId, state: "pending", queued: true }],
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [row],
          sessionInfo: row,
          inFlightRun: history.inFlightRun,
          methodResponses: { "chat.startup": history, "chat.history": history },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const queue = page.locator('[data-chat-queue-item="pending-input:layout-input"]');
        await queue.waitFor();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Also check the narrow-screen layout.");
        const control = queue.getByRole("button", { name: "Steer queued message", exact: true });
        await expect.poll(() => control.count()).toBe(1);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".chat"),
          [queue, composer, control],
          { animations: "disabled" },
        );
        writeFileSync(suite.artifactDir + "/queued-input.png", frame.png);
        await gateway.deferNext("chat.steer");
        await control.click();
        expect((await gateway.waitForRequest("chat.steer")).params).toEqual({
          sessionKey,
          agentId: "main",
          sessionId,
          runId: queued.runId,
        });
        await expect.poll(() => control.getAttribute("aria-busy")).toBe("true");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.setMethodResponse("chat.history", {
          ...history,
          pendingInputs: { items: [], total: 0, queuedCount: 0 },
          inputReceipts: [{ runId: queued.runId, state: "consumed" }],
        });
        await gateway.resolveDeferred("chat.steer", {
          status: "accepted",
          targetRunId: "active-review",
        });
        await queue.waitFor({ state: "detached" });
        expect(await composer.inputValue()).toBe("Also check the narrow-screen layout.");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("chat.steer")).toHaveLength(1);
      },
    );
  });
});
