import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Projected pending input dismissal" });
const sessionKey = "agent:main:main";
const sessionId = "session:" + sessionKey;
const saved = {
  id: "saved-input",
  runId: "saved-run",
  acceptedAt: 1,
  state: "interrupted",
  message: { role: "user", content: "Synthetic saved request", timestamp: 1 },
};
const bulkName = "Dismiss all interrupted and cancelled messages shown";

suite.define(() => {
  it("leaves no dismissal footer when history already owns the saved input", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const messages = [
        { ...saved.message, __openclaw: { id: saved.id, seq: 1 } },
        { role: "assistant", content: "Synthetic completed reply.", timestamp: 2 },
      ];
      const history = {
        sessionId,
        messages,
        pendingInputs: { items: [saved], total: 1, queuedCount: 0 },
      };
      await installMockGateway(page, {
        sessionKey,
        historyMessages: messages,
        featureMethods: [...defaultControlUiFeatureMethods, "chat.pendingInputs.dismiss"],
        methodResponses: { "chat.startup": history, "chat.history": history },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const reply = page.getByText("Synthetic completed reply.", { exact: true });
      await reply.waitFor();
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator(".chat-footer"),
        [reply],
        {
          animations: "disabled",
        },
      );
      await writeFile(suite.artifactDir + "/empty-footer.png", frame.png);
      expect(await page.getByRole("button", { name: bulkName, exact: true }).count()).toBe(0);
      expect(
        await page
          .getByRole("button", {
            name: "Dismiss interrupted message: Synthetic saved request",
            exact: true,
          })
          .count(),
      ).toBe(0);
    });
  });

  it("dismisses loaded offscreen targets, then uses only the selected older page", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const messages = Array.from({ length: 40 }, (_, index) => ({
        role: "assistant",
        content: "Synthetic conversation message " + (index + 1) + ".",
        timestamp: index + 10,
        __openclaw: { id: "message-" + index, seq: index + 1 },
      }));
      const latest = {
        sessionId,
        messages,
        pendingInputs: { items: [saved], total: 2, queuedCount: 0, nextBefore: 1 },
      };
      const olderInput = {
        ...saved,
        id: "older-input",
        runId: "older-run",
        message: { role: "user", content: "Synthetic older request", timestamp: 1 },
      };
      const older = { ...latest, pendingInputs: { items: [olderInput], total: 2, queuedCount: 0 } };
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: messages,
        featureMethods: [...defaultControlUiFeatureMethods, "chat.pendingInputs.dismiss"],
        heldMethods: ["chat.pendingInputs.dismiss"],
        methodResponses: {
          "chat.startup": latest,
          "chat.history": {
            cases: [
              { match: { pendingBefore: 1 }, response: older },
              { match: {}, response: latest },
            ],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByText("Synthetic conversation message 40.", { exact: true }).waitFor();
      expect(
        await page
          .getByRole("button", {
            name: "Dismiss interrupted message: Synthetic saved request",
            exact: true,
          })
          .isVisible(),
      ).toBe(false);
      await page.getByRole("button", { name: bulkName, exact: true }).click();
      const first = await gateway.waitForRequest("chat.pendingInputs.dismiss");
      expect(requireRecord(first.params).inputIds).toEqual(["saved-input"]);
      await gateway.resolveDeferred("chat.pendingInputs.dismiss", {
        dismissedIds: ["saved-input"],
        runIds: ["saved-run"],
        missingIds: [],
      });
      await page
        .getByRole("button", { name: bulkName, exact: true })
        .waitFor({ state: "detached" });
      const earlier = page.getByRole("button", {
        name: "Show earlier unsent messages",
        exact: true,
      });
      await page.locator(".chat-thread").hover();
      await page.mouse.wheel(0, -10000);
      await earlier.click();
      await page
        .getByRole("button", {
          name: "Dismiss interrupted message: Synthetic older request",
          exact: true,
        })
        .waitFor();
      await gateway.deferNext("chat.pendingInputs.dismiss");
      await page.getByRole("button", { name: bulkName, exact: true }).click();
      await gateway.waitForRequest("chat.pendingInputs.dismiss", {
        match: { inputIds: ["older-input"] },
      });
      const requests = await gateway.getRequests("chat.pendingInputs.dismiss");
      expect(requests.map((request) => requireRecord(request.params).inputIds)).toEqual([
        ["saved-input"],
        ["older-input"],
      ]);
      await gateway.resolveDeferred("chat.pendingInputs.dismiss", {
        dismissedIds: ["older-input"],
        runIds: ["older-run"],
        missingIds: [],
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
