import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProofEnabled } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Synthetic explicit source reply proof",
  trackBrowserContexts: true,
});
suite.define(() => {
  it("keeps an explicit delivered reply outside closed work after reload", async () => {
    await suite.withPage(
      { viewport: { width: 1100, height: 850 }, colorScheme: "light" },
      async ({ page }) => {
        const key = "agent:main:dashboard:source-reply-proof";
        const row = (
          id: string,
          role: string,
          content: string,
          timestamp: number,
          fields: object = {},
        ) => ({
          role,
          content,
          timestamp,
          __openclaw: { id, seq: timestamp, runId: "synthetic-run" },
          ...fields,
        });
        const delivered = row(
          "delivered",
          "assistant",
          "Explicit delivered reply stays in the conversation.",
          2000,
          { openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false } },
        );
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          sessions: [{ key, label: "Source reply visibility", kind: "direct", updatedAt: 4000 }],
          historyMessages: [
            row("prompt", "user", "Prepare a short reply.", 1000),
            row("work-before", "assistant", "Checking the request internally.", 1500),
            delivered,
            row("work-after", "assistant", "Finishing internal bookkeeping.", 2500),
            row("answer", "assistant", "Acknowledged.", 3000, { phase: "final_answer" }),
            row("speech", "assistant", "Spoken acknowledgment.", 4000, {
              __openclaw: {
                id: "speech",
                runId: "synthetic-run",
                voiceTranscript: "provider-owned",
              },
            }),
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const work = page.locator(".chat-work-group button").first();
        await work.waitFor();
        await expect.poll(() => work.getAttribute("aria-expanded")).toBe("false");
        await expect.poll(() => page.locator('[data-entry-id="delivered"]').count()).toBe(1);
        expect(
          await page.getByText("Checking the request internally.", { exact: true }).count(),
        ).toBe(0);
        for (let index = 0; index < 2; index += 1) {
          await gateway.emitGatewayEvent("session.message", {
            sessionKey: key,
            runId: "synthetic-run",
            messageId: "delivered",
            messageSeq: 2000,
            message: delivered,
            hasActiveRun: false,
            activeRunIds: [],
          });
        }
        await expect.poll(() => page.locator('[data-entry-id="delivered"]').count()).toBe(1);
        await page.reload();
        await work.waitFor();
        await expect.poll(() => page.locator('[data-entry-id="delivered"]').count()).toBe(1);
        if (captureUiProofEnabled) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("body"),
            [page.locator(".chat-thread")],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "source-reply.png"), frame.png);
        }
      },
    );
  });
});
