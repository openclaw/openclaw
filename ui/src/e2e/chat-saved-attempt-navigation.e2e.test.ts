import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Saved-attempt history navigation" });

suite.define(() => {
  it.each([1280, 390])(
    "keeps saved-attempt navigation in scrolling history at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:main";
        const sessionId = "session:" + sessionKey;
        const saved = {
          id: "saved-input",
          runId: "saved-run",
          acceptedAt: 1,
          state: "cancelled",
          message: { role: "user", content: "Synthetic cancelled request" },
        };
        const messages = Array.from({ length: 40 }, (_, index) => ({
          role: "assistant",
          content: `Synthetic conversation message ${index + 1}.`,
          timestamp: 2 + index,
          __openclaw: { id: `message-${index}`, seq: index + 1 },
        }));
        const latest = {
          sessionId,
          messages,
          pendingInputs: { items: [saved], total: 41, queuedCount: 0, nextBefore: 21 },
        };
        const older = {
          ...latest,
          pendingInputs: {
            items: [{ ...saved, id: "older-input", runId: "older-run" }],
            total: 41,
            queuedCount: 0,
            nextBefore: 1,
          },
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: messages,
          methodResponses: {
            "chat.startup": latest,
            "chat.history": {
              cases: [
                { match: { pendingBefore: 21 }, response: older },
                { match: {}, response: latest },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const tail = page.getByText("Synthetic conversation message 40.", { exact: true });
        await tail.waitFor();
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".chat-footer"),
          [tail],
          {
            animations: "disabled",
          },
        );
        await writeFile(suite.artifactDir + `/latest-${width}.png`, frame.png);
        const earlier = page.getByRole("button", { name: "Show earlier messages", exact: true });
        expect(
          await page
            .locator(".chat-footer")
            .getByRole("button", { name: "Show earlier messages", exact: true })
            .count(),
        ).toBe(0);
        expect(
          await page
            .locator(".chat-thread")
            .getByRole("button", { name: "Show earlier messages", exact: true })
            .count(),
        ).toBe(1);

        const thread = page.locator(".chat-thread");
        await thread.hover();
        await page.mouse.wheel(0, -10000);
        await earlier.waitFor();
        await earlier.click();
        const backToLatest = page.getByRole("button", {
          name: "Show latest messages",
          exact: true,
        });
        await backToLatest.waitFor();
        const navigation = page.locator(".chat-thread .chat-pending-inputs--history");
        const historyFrame = await takeControlUiScreenshotFrame(
          page,
          navigation,
          [earlier, backToLatest],
          {
            animations: "disabled",
            elements: [navigation],
            scrollTo: navigation,
          },
        );
        await writeFile(suite.artifactDir + `/history-${width}.png`, historyFrame.png);
        expect(
          await navigation.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return [...element.querySelectorAll("button")].every((button) => {
              const target = button.getBoundingClientRect();
              return (
                target.top >= bounds.top &&
                target.bottom <= bounds.bottom &&
                target.left >= bounds.left &&
                target.right <= bounds.right
              );
            });
          }),
        ).toBe(true);
        expect(
          (await gateway.getRequests("chat.history")).some(
            (request) => requireRecord(request.params).pendingBefore === 21,
          ),
        ).toBe(true);

        await page.getByRole("button", { name: "Scroll to latest", exact: true }).click();
        await tail.waitFor();
        // Visiting the live tail does not abandon the selected saved-history page.
        expect(await backToLatest.count()).toBe(1);
        await backToLatest.click();
        await backToLatest.waitFor({ state: "detached" });
        expect(await page.locator(".chat-footer .chat-pending-inputs--history").count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );
});
