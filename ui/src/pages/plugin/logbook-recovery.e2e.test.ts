import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { logbookStatus, logbookTimeline } from "./logbook.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Logbook action recovery" });
suite.define(() => {
  it("retires recovered action failures without clearing independent timeline failures", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const day = "2026-11-15";
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          deferredMethods: ["logbook.timeline"],
          controlUiTabs: [
            { group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" },
          ],
          methodResponses: {
            "logbook.status": logbookStatus(day, { visionModelSource: "config" }),
            "logbook.timeline": logbookTimeline(day, [
              {
                title: "Reviewing a synthetic project",
                detail: "Retained activity detail",
                startMs: Date.UTC(2026, 10, 15, 10),
                endMs: Date.UTC(2026, 10, 15, 10, 35),
              },
            ]),
          },
        });
        await page.goto(suite.server.baseUrl + "plugin?plugin=logbook&id=logbook");
        const view = page.locator(".logbook");
        const form = view.locator(".logbook-ask__form");
        const input = form.getByRole("textbox");
        const ask = form.getByRole("button");
        await input.fill("What did I work on?");
        await gateway.rejectDeferred("logbook.timeline", {
          message: "Synthetic timeline unavailable",
        });
        await view
          .getByRole("alert")
          .filter({ hasText: "Synthetic timeline unavailable" })
          .waitFor();
        expect(await view.locator(".logbook__empty").count()).toBe(0);
        await view.getByRole("button", { name: "Refresh", exact: true }).click();
        const card = view.getByRole("button", { name: /Reviewing a synthetic project/ });
        await card.waitFor();
        expect(await input.inputValue()).toBe("What did I work on?");
        await card.click();
        await view.getByText("Retained activity detail", { exact: true }).waitFor();
        const failAction = async (method: string, button: typeof ask, message: string) => {
          const after = await gateway.deferNext(method);
          await button.click();
          await gateway.waitForRequest(method, { after });
          await gateway.rejectDeferred(method, { message });
          await view.getByRole("alert").filter({ hasText: message }).waitFor();
          await expect.poll(() => button.isDisabled()).toBe(false);
        };
        await failAction("logbook.ask", ask, "Synthetic answer service unavailable");
        await gateway.setMethodResponse("logbook.ask", {
          answer: "You reviewed a synthetic project.",
        });
        const retryAsk = await gateway.deferNext("logbook.ask");
        await ask.click();
        await gateway.waitForRequest("logbook.ask", { after: retryAsk });
        await expect.poll(() => ask.isDisabled()).toBe(true);
        expect.soft(await view.getByRole("alert").count()).toBe(0);
        await gateway.resolveDeferred("logbook.ask");
        const answer = view.getByText("You reviewed a synthetic project.", { exact: true });
        await answer.waitFor();
        await expect.poll(() => ask.isDisabled()).toBe(false);
        expect
          .soft(
            await view
              .getByRole("alert")
              .filter({ hasText: "Synthetic answer service unavailable" })
              .count(),
          )
          .toBe(0);
        const frame = await takeControlUiScreenshotFrame(page, view, [answer, card], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "recovered-answer.png"), frame.png);
        await view.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect.poll(() => view.getByRole("alert").count()).toBe(0);
        const standup = view
          .locator(".logbook-side__card")
          .filter({ hasText: "Daily standup" })
          .getByRole("button");
        await failAction("logbook.standup", standup, "Synthetic standup service unavailable");
        await gateway.setMethodResponse("logbook.standup", {
          day,
          text: "Completed a synthetic review.",
          updatedMs: 1,
        });
        const retryStandup = await gateway.deferNext("logbook.standup");
        await standup.click();
        await gateway.waitForRequest("logbook.standup", { after: retryStandup });
        await expect.poll(() => standup.isDisabled()).toBe(true);
        expect.soft(await view.getByRole("alert").count()).toBe(0);
        await gateway.resolveDeferred("logbook.standup");
        await view
          .locator(".logbook-standup__body")
          .getByText("Completed a synthetic review.")
          .waitFor();
        await expect.poll(() => standup.isDisabled()).toBe(false);
        expect
          .soft(
            await view
              .getByRole("alert")
              .filter({ hasText: "Synthetic standup service unavailable" })
              .count(),
          )
          .toBe(0);
        const after = await gateway.deferNext("logbook.timeline");
        await view.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("logbook.timeline", { after });
        // Equal error text must not confuse ownership: this failure is from the timeline read.
        await gateway.rejectDeferred("logbook.timeline", {
          message: "Synthetic answer service unavailable",
        });
        const readError = view
          .getByRole("alert")
          .filter({ hasText: "Synthetic answer service unavailable" });
        await readError.waitFor();
        await gateway.setMethodResponse("logbook.ask", { answer: "Independent accepted answer." });
        await ask.click();
        await view.getByText("Independent accepted answer.", { exact: true }).waitFor();
        expect(await readError.isVisible()).toBe(true);
        expect(await view.getByText("Retained activity detail", { exact: true }).isVisible()).toBe(
          true,
        );
        expect(await input.inputValue()).toBe("What did I work on?");
        expect(await gateway.getRequests("logbook.ask")).toHaveLength(3);
        expect(await gateway.getRequests("logbook.standup")).toHaveLength(2);
        expect(await gateway.getRequests("logbook.capture.set")).toHaveLength(0);
      },
    );
  });
});
