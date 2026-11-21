import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("keeps an unavailable widget terminal through later chat events", async () => {
    const sessionKey = "agent:main:canvas-unavailable";
    const docId = "canvas-synthetic-pruned";
    const unavailable =
      "Canvas widget unavailable; reload the chat or ask the agent to recreate it.";
    const history = prepareChatHistoryFixture([
      { role: "user", content: "Show the saved synthetic checklist." },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "canvas-proof", name: "show_widget", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "canvas-proof",
        toolName: "show_widget",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "canvas",
              view: { id: docId, url: `/__openclaw__/canvas/documents/${docId}/index.html` },
              presentation: {
                target: "assistant_message",
                title: "Saved synthetic checklist",
                sandbox: "scripts",
                preferredHeight: 320,
              },
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: "This saved widget has been removed. All content here is synthetic.",
      },
    ]);
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width: 1280, height: 900 },
        colorScheme: "light",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
          communityInvite: false,
          historyMessages: history.messages,
          featureMethods: [...defaultControlUiFeatureMethods, "canvas.document.view"],
          methodResponses: {
            "chat.history": history,
            "canvas.document.view": { __mockError: { code: "UNAVAILABLE", message: unavailable } },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        for (const group of await page
          .locator('.chat-activity-group__summary[aria-expanded="false"]')
          .all()) {
          await group.click();
        }
        await page.locator(".chat-tool-msg-summary").first().click();
        const widget = page.locator(".chat-thread openclaw-canvas-widget-view").first();
        const error = widget.getByRole("alert");
        await error.waitFor();
        expect(await error.textContent()).toContain(unavailable);
        for (let index = 0; index < 12; index += 1) {
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId: `synthetic-later-${index}`,
            state: "final",
          });
          await error.waitFor();
        }
        const screenshot = await takeControlUiScreenshotFrame(
          page,
          page.locator(".chat-thread"),
          [error],
          {
            animations: "disabled",
            elements: [error],
          },
        );
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await writeFile(path.join(suite.artifactDir, "canvas-unavailable.png"), screenshot.png);
          await writeFile(
            path.join(suite.artifactDir, "canvas-unavailable-bounds.json"),
            JSON.stringify(
              screenshot.elements.map(({ bounds }) => bounds),
              null,
              2,
            ),
          );
          console.log("Canvas unavailable proof:", suite.artifactDir);
        }
        const viewRequests = await gateway.getRequests("canvas.document.view");
        console.log("Canvas unavailable requests after 12 later events:", viewRequests.length);
        expect.soft(viewRequests).toHaveLength(1);
        expect
          .soft(await error.getByRole("button", { name: "Retry", exact: true }).count())
          .toBe(0);
      },
    );
  });
});
