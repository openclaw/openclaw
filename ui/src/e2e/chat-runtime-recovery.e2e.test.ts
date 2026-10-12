import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect as browserExpect } from "playwright/test";
import { assert, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI runtime recovery" });
const failures = [
  {
    name: "pipe",
    diagnostic: "write EPIPE | EPIPE",
    recovery:
      "The agent runtime disconnected. Check the task before retrying. If its worktree was removed, restore it in Worktrees or start a new session.",
  },
  {
    name: "worktree",
    diagnostic: "managed worktree was removed: /tmp/example/deleted-worktree",
    recovery:
      "This session's worktree is unavailable. Restore it in Worktrees, then retry, or start a new session in the source repository. Your transcript is preserved.",
  },
] as const;

suite.define(() => {
  for (const source of ["live", "history"] as const) {
    it.each(failures)(
      `shows $name recovery from ${source} without replaying the request`,
      async ({ name, diagnostic, recovery }) => {
        await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
          const sessionKey = "agent:main:main";
          const gateway = await installMockGateway(page, {
            sessionKey,
            ...(source === "history"
              ? {
                  historyMessages: [
                    {
                      role: "custom",
                      customType: "run-failed-before-reply",
                      content: `Your request couldn't be completed: ${diagnostic}`,
                      details: { runId: "failed-runtime" },
                    },
                  ],
                  sessionInfo: {
                    key: sessionKey,
                    kind: "direct",
                    status: "failed",
                    hasActiveRun: false,
                    lastRunId: "failed-runtime",
                    lastRunError: diagnostic,
                  },
                }
              : {}),
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          if (source === "live") {
            await page.locator(".agent-chat__input textarea").fill("Continue the task");
            await page.getByRole("button", { name: "Send message" }).click();
            const send = await gateway.waitForRequest("chat.send");
            assert(isRecord(send.params) && typeof send.params.idempotencyKey === "string");
            await gateway.emitGatewayEvent("chat", {
              sessionKey,
              runId: send.params.idempotencyKey,
              state: "error",
              errorMessage: diagnostic,
            });
          }
          const alert = page.locator(".chat-error");
          await alert.waitFor();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              path: path.join(suite.artifactDir, `${name}-${source}-collapsed.png`),
              animations: "disabled",
            });
          }
          await browserExpect(
            alert.locator("summary").getByText(recovery, { exact: true }),
          ).toBeVisible();
          await browserExpect(alert.getByLabel("Error details", { exact: true })).not.toBeVisible();
          expect(await alert.locator("summary").textContent()).not.toContain("/tmp/example");
          await alert.locator("summary").click();
          await browserExpect(alert.getByLabel("Error details", { exact: true })).toBeVisible();
          expect(await alert.getByLabel("Error details", { exact: true }).textContent()).toContain(
            diagnostic,
          );
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              path: path.join(suite.artifactDir, `${name}-${source}-expanded.png`),
              animations: "disabled",
            });
          }
          await alert.locator("summary").click();
          await page.setViewportSize({ width: 393, height: 852 });
          await browserExpect(
            alert.locator("summary").getByText(recovery, { exact: true }),
          ).toBeVisible();
          expect(await alert.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              path: path.join(suite.artifactDir, `${name}-${source}-mobile.png`),
              animations: "disabled",
            });
          }
          const input = page.locator(".agent-chat__input textarea");
          await input.fill("Keep this draft");
          const historyCount = (await gateway.getRequests("chat.history")).length;
          await alert.getByRole("button", { name: "Refresh", exact: true }).click();
          await gateway.waitForRequest("chat.history", { after: historyCount });
          expect(await input.inputValue()).toBe("Keep this draft");
          expect(await gateway.getRequests("chat.send")).toHaveLength(source === "live" ? 1 : 0);
          if (source === "history") {
            await page.reload();
            await browserExpect(
              page.locator(".chat-error summary").getByText(recovery, { exact: true }),
            ).toBeVisible();
          }
        });
      },
    );
  }
});
