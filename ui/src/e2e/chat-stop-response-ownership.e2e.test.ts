import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Stop response ownership" });

suite.define(() => {
  it.each(["current", "replacement"] as const)(
    "keeps a delayed Stop rejection with its original run after %s work",
    async (owner) => {
      await suite.withPage({ viewport: { width: 1200, height: 800 } }, async ({ page }) => {
        const sessionKey = "agent:main:main";
        const gateway = await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__input textarea");
        const send = page.getByRole("button", { name: "Send message", exact: true });
        const stop = page.getByRole("button", { name: "Stop generating" });
        await composer.fill("Start the original task.");
        await send.click();
        const original = await gateway.waitForRequest("chat.send");
        expect(original.params).toMatchObject({ sessionKey, idempotencyKey: expect.any(String) });
        const runId = String(asOptionalRecord(original.params)?.idempotencyKey);
        await stop.waitFor();
        await gateway.deferNext("chat.abort");
        await stop.click();
        const abort = await gateway.waitForRequest("chat.abort");
        expect(abort.params).toEqual({ sessionKey, runId });

        let activeRunId = runId;
        if (owner === "replacement") {
          // The old run can settle before its held Stop acknowledgement reaches the browser.
          await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "aborted" });
          await stop.waitFor({ state: "detached" });
          await composer.fill("Start the replacement task.");
          await send.click();
          const replacement = await gateway.waitForRequest("chat.send", { after: 1 });
          expect(replacement.params).toMatchObject({
            sessionKey,
            idempotencyKey: expect.any(String),
          });
          activeRunId = String(asOptionalRecord(replacement.params)?.idempotencyKey);
          expect(activeRunId).not.toBe(runId);
          await stop.waitFor();
        }
        const progress =
          owner === "replacement" ? "Replacement task is working." : "Original task is working.";
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId: activeRunId,
          state: "delta",
          deltaText: progress,
        });
        const activeReply = page.locator(".chat-bubble").getByText(progress, { exact: true });
        await activeReply.waitFor();
        await composer.fill("Keep this next-message draft.");
        const failure = "The original Stop acknowledgement failed.";
        await gateway.rejectDeferred("chat.abort", { code: "UNAVAILABLE", message: failure });
        // The mock delivers synchronously; cross a rendered frame after its promise handlers.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        await page.screenshot({
          path: path.join(suite.artifactDir, `${owner}-after-stop-rejection.png`),
          fullPage: false,
        });

        expect(await activeReply.isVisible()).toBe(true);
        expect(await composer.inputValue()).toBe("Keep this next-message draft.");
        await composer.fill("");
        await stop.waitFor({ state: "visible" });
        expect(await gateway.getRequests("chat.abort")).toEqual([abort]);
        expect(await gateway.getRequests("chat.send")).toHaveLength(
          owner === "replacement" ? 2 : 1,
        );
        if (owner === "current") {
          await page.getByText(failure, { exact: true }).waitFor();
        } else {
          expect(await page.getByText(failure, { exact: false }).count()).toBe(0);
        }
      });
    },
  );
});
