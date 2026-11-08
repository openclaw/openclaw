import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  textContent,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("keeps a cached ongoing conversation readable after a phone refresh", async () => {
    const page = await newChatPage(suite, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
    });
    const runId = "active-history-run";
    const sessionKey = "agent:main:chat:mobile-history";
    const sessionId = "active-history-session";
    const sessionInfo = createControlUiSessionRow(sessionKey, "Fix mobile history", 1, {
      sessionId,
      activeRunIds: [runId],
      hasActiveRun: true,
      status: "running",
    });
    const inFlightRun = { runId, text: "" };
    const message = (seq: number, role: string, text: string) => ({
      __openclaw: { id: "row-" + seq, seq, runId },
      role,
      content: textContent(text),
      timestamp: 1_800_000_000_000 + seq,
      ...(role === "toolResult" ? { toolCallId: "tool-" + seq, toolName: "read" } : {}),
    });
    const opening = [
      message(1, "user", "Please fix the mobile conversation history."),
      message(2, "assistant", "I am checking why the conversation disappears after refresh."),
    ];
    const tail = Array.from({ length: 80 }, (_, index) =>
      message(index + 3, "toolResult", "Checked the current settings."),
    );
    const gateway = await installMockGateway(page, {
      sessionKey,
      sessions: [sessionInfo],
      authMethod: "trusted-proxy",
      authMode: "trusted-proxy",
      deferredMethods: ["connect"],
      methodResponses: {
        "chat.startup": {
          messages: [...opening, ...tail],
          sessionId,
          sessionInfo,
          inFlightRun,
          hasMore: false,
          totalMessages: 82,
        },
        "chat.history": {
          cases: [
            {
              match: { messageId: "row-3" },
              response: {
                messages: [tail[0]],
                sessionId,
                hasMore: true,
                olderCursor: "older-active",
                totalMessages: 82,
              },
            },
            {
              match: { cursor: "older-active" },
              response: { messages: opening, sessionId, hasMore: false, totalMessages: 82 },
            },
          ],
        },
      },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await gateway.waitForRequest("connect");
    await gateway.resolveDeferred("connect");
    const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
    const prompt = thread.getByText("Please fix the mobile conversation history.", { exact: true });
    await prompt.waitFor();
    await waitForChatScrollIdle(page);
    await page.evaluate(async () => {
      await Reflect.get(
        document.querySelector(".chat-pane-cache__pane--active")!,
        "sessionSnapshotStore",
      ).flush();
    });
    await gateway.setMethodResponse("chat.startup", {
      messages: tail,
      sessionId,
      sessionInfo,
      inFlightRun,
      hasMore: true,
      olderCursor: "older-active",
      nextOffset: 80,
      totalMessages: 82,
    });
    await page.reload();
    await gateway.waitForRequest("connect");
    await gateway.resolveDeferred("connect");
    await thread.locator(".chat-virtual-row").last().waitFor();
    await waitForChatScrollIdle(page);
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const capture = await takeControlUiScreenshotFrame(
        page,
        thread,
        [thread.locator(".chat-virtual-row").last()],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, "phone-refresh.png"), capture.png);
    }
    await expect.poll(() => prompt.isVisible()).toBe(true);
    expect(await gateway.getRequests("chat.history")).toHaveLength(2);
    await expect
      .poll(() =>
        thread
          .locator(".chat-text")
          .getByText("I am checking why the conversation disappears after refresh.", {
            exact: true,
          })
          .isVisible(),
      )
      .toBe(true);
  });
});
