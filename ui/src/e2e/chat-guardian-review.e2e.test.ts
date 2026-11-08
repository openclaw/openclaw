import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { composer, sendChat, timedText } from "./chat-flow-fixtures.test-support.ts";
import { requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Guardian strict review mocked Gateway E2E",
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { height: 900, width: 1280 };

suite.define(() => {
  it("shows and settles a strict Guardian review in the active chat", async () => {
    const proofDir = captureProof
      ? createControlUiE2eArtifactDir("codex-guardian-review")
      : undefined;
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(proofDir ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [timedText("assistant", "Ready for a Guardian-reviewed action.")],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Ready for a Guardian-reviewed action.").waitFor();
        const request = await sendChat(page, gateway, "Review this action.");
        const runId = requireString(request.idempotencyKey, "chat run id");
        const capture = async (name: string, target: Locator = composer(page)) => {
          if (proofDir) {
            await writeFile(
              path.join(proofDir, name),
              await takeControlUiViewportScreenshot(page, page.locator(".shell"), [target]),
            );
          }
        };
        await capture("01-before-review.png");
        const correlation = {
          reviewId: "guardian-review-1",
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
        };
        let sequence = 0;
        const reviewEvent = (data: Record<string, unknown>) =>
          gateway.emitGatewayEvent("agent", {
            runId,
            sessionKey: "main",
            stream: "codex_app_server.guardian",
            data: { ...correlation, ...data },
            seq: ++sequence,
            ts: Date.now(),
          });
        await reviewEvent({ phase: "strict_review_required", startedAtMs: Date.now() });

        const notice = page.getByRole("alert").filter({ hasText: "Guardian review required" });
        await notice.waitFor({ state: "visible" });
        expect(await notice.textContent()).toContain(
          "Guardian is reviewing this action before it can continue.",
        );

        await capture("02-review-required.png", notice);
        await reviewEvent({ phase: "completed", status: "approved" });
        await expect.poll(() => notice.count()).toBe(0);

        await capture("03-review-approved.png");
      },
    );
  });
});
