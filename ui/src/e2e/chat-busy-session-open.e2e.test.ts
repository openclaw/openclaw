import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Busy chat open",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("opens a busy chat whose run appends messages faster than history reads return", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const busyKey = "agent:main:busy";
      const history = [
        {
          role: "user",
          content: "Start the long task",
          timestamp: 1,
          __openclaw: { id: "u1", seq: 1 },
        },
        {
          role: "assistant",
          content: "Earlier progress note",
          timestamp: 2,
          __openclaw: { id: "a1", seq: 2 },
        },
      ];
      const gateway = await installMockGateway(page, {
        historyMessages: history,
        sessions: [
          { key: "agent:main:main", kind: "direct", label: "Home", updatedAt: 2 },
          { key: busyKey, kind: "direct", label: "Busy", updatedAt: 1, hasActiveRun: true },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "main"));
      const pane = () => page.locator(".chat-pane-cache__pane--active");
      await pane().getByText("Earlier progress note").first().waitFor();

      // Every history read takes 400 ms while the run appends a message every 150 ms.
      await gateway.setMethodDelay("chat.startup", 400);
      await gateway.setMethodDelay("chat.history", 400);
      let seq = 10;
      const streaming = new AbortController();
      const stream = (async () => {
        while (!streaming.signal.aborted) {
          seq += 1;
          await gateway.emitGatewayEvent("session.message", {
            sessionKey: busyKey,
            hasActiveRun: true,
            messageId: `live-${seq}`,
            messageSeq: seq,
            message: {
              role: "toolResult",
              toolCallId: `call-${seq}`,
              toolName: "exec",
              content: [{ type: "text", text: `step ${seq}` }],
              __openclaw: { id: `live-${seq}`, seq },
            },
          });
          await page.waitForTimeout(150);
        }
      })();
      try {
        await page.locator(`.sidebar-recent-session[data-session-key="${busyKey}"] a`).click();
        await expect
          .poll(() => pane().getByText("Earlier progress note").count(), { timeout: 5_000 })
          .toBeGreaterThan(0);
      } finally {
        streaming.abort();
        await stream;
      }
    });
  });
});
