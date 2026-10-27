import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Stop response ownership" });

const scenarios = ["current", "replacement", "button", "command", "deferred save"] as const;

async function verifyStopResponse(page: Page, scenario: (typeof scenarios)[number]) {
  const saveWarning =
    scenario === "button" || scenario === "command" || scenario === "deferred save";
  const sessionKey = "agent:main:main";
  const gateway = await installMockGateway(page, { sessionKey });
  const emitReply = (runId: string, state: "delta" | "aborted", text: string) =>
    gateway.emitGatewayEvent("chat", {
      sessionKey,
      runId,
      state,
      ...(state === "delta" ? { deltaText: text } : {}),
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const composer = page.locator(".agent-chat__input textarea");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const stop = page.getByRole("button", { name: "Stop generating" });
  const start = async (prompt: string, reply: string, after = 0) => {
    await composer.fill(prompt);
    await send.click();
    const request = await gateway.waitForRequest("chat.send", { after });
    expect(request.params).toMatchObject({ sessionKey, idempotencyKey: expect.any(String) });
    const id = String(asOptionalRecord(request.params)?.idempotencyKey);
    await emitReply(id, "delta", reply);
    return id;
  };
  const progress = "Original task is working.";
  const runId = await start("Start the original task.", progress);
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
    scenario === "command"
      ? { key: sessionKey, clearQueued: true, userInitiated: true }
      : { sessionKey, runId, userInitiated: true },
  );

  if (scenario !== "current") {
    await emitReply(runId, "aborted", progress);
    await stop.waitFor({ state: "detached" });
  }
  let visibleReply = progress;
  if (scenario === "replacement") {
    visibleReply = "Replacement task is working.";
    expect(await start("Start the replacement task.", visibleReply, 1)).not.toBe(runId);
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
  expect(await reply.isVisible()).toBe(true);
  expect(await composer.inputValue()).toBe("Keep this next-message draft.");
  await composer.fill("");
  await stop.waitFor({ state: saveWarning ? "detached" : "visible" });
  expect(await gateway.getRequests(abortMethod)).toEqual([abort]);
  expect(await gateway.getRequests("chat.send")).toHaveLength(scenario === "replacement" ? 2 : 1);
}

suite.define(() => {
  it.each(scenarios)("keeps a delayed Stop response with its original run (%s)", (scenario) =>
    suite.withPage({ viewport: { width: 1200, height: 800 } }, ({ page }) =>
      verifyStopResponse(page, scenario),
    ),
  );
});
