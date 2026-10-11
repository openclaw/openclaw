import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Stop response ownership" });

suite.define(() => {
  it.each(["current", "replacement", "button", "command", "deferred save"] as const)(
    "keeps a delayed Stop response with its original run (%s)",
    async (scenario) => {
      const saveWarning =
        scenario === "button" || scenario === "command" || scenario === "deferred save";
      const pageOptions = {
        viewport: { width: 1200, height: 800 },
        ...(saveWarning
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1200, height: 800 } } }
          : {}),
      };
      await suite.withPage(pageOptions, async ({ page }) => {
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
        const progress = "Original task is working.";
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "delta",
          deltaText: progress,
          message: { role: "assistant", content: [{ type: "text", text: progress }] },
        });
        await page.locator(".chat-bubble").getByText(progress, { exact: true }).waitFor();
        const abortMethod = scenario === "command" ? "sessions.abort" : "chat.abort";
        await gateway.deferNext(abortMethod);
        if (scenario === "command") {
          await composer.fill("/stop");
          await composer.press("Enter");
        } else {
          await stop.click();
        }
        const abort = await gateway.waitForRequest(abortMethod);
        expect(abort.params).toEqual(
          scenario === "command" ? { key: sessionKey, clearQueued: true } : { sessionKey, runId },
        );

        if (scenario !== "current") {
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: "aborted",
            message: { role: "assistant", content: [{ type: "text", text: progress }] },
          });
          await stop.waitFor({ state: "detached" });
        }
        let visibleReply = progress;
        if (scenario === "replacement") {
          await composer.fill("Start the replacement task.");
          await send.click();
          const replacement = await gateway.waitForRequest("chat.send", { after: 1 });
          const replacementRunId = String(asOptionalRecord(replacement.params)?.idempotencyKey);
          expect(replacementRunId).not.toBe(runId);
          visibleReply = "Replacement task is working.";
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId: replacementRunId,
            state: "delta",
            deltaText: visibleReply,
            message: { role: "assistant", content: [{ type: "text", text: visibleReply }] },
          });
        }
        const reply = page.locator(".chat-bubble").getByText(visibleReply, { exact: true });
        await reply.waitFor();
        await composer.fill("Keep this next-message draft.");
        const notice = saveWarning
          ? "Stopped, but a reply could not be saved to history. Copy any visible text before leaving this chat."
          : "The original Stop acknowledgement failed.";
        if (saveWarning) {
          await gateway.resolveDeferred(abortMethod, {
            ...(scenario === "command"
              ? { status: "aborted", abortedRunId: runId }
              : { aborted: true, runIds: [runId] }),
            ...(scenario === "deferred save" ? {} : { warning: notice }),
          });
          if (scenario === "deferred save") {
            await gateway.emitGatewayEvent("chat", {
              sessionKey,
              runId,
              state: "error",
              errorMessage: notice,
              stopReason: "aborted-partial-persistence-failed",
            });
          }
        } else {
          await gateway.rejectDeferred(abortMethod, { code: "UNAVAILABLE", message: notice });
        }
        // A replacement must remain unchanged after the old response's promise handlers.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        if (scenario === "replacement") {
          expect(await page.getByText(notice, { exact: false }).count()).toBe(0);
        } else {
          await page.getByText(notice, { exact: true }).waitFor();
        }
        await page.screenshot({
          path: path.join(suite.artifactDir, scenario + "-stop-response.png"),
          fullPage: false,
        });
        expect(await reply.isVisible()).toBe(true);
        expect(await composer.inputValue()).toBe("Keep this next-message draft.");
        await composer.fill("");
        await stop.waitFor({ state: saveWarning ? "detached" : "visible" });
        expect(await gateway.getRequests(abortMethod)).toEqual([abort]);
        expect(await gateway.getRequests("chat.send")).toHaveLength(
          scenario === "replacement" ? 2 : 1,
        );
      });
    },
  );
});
