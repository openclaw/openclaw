import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Background run lifecycle",
  trackBrowserContexts: true,
});
suite.define(() => {
  it.each(["agent:main:main", "agent:main:dashboard:00000000-0000-4000-8000-000000000002"])(
    "keeps a background tool run active through compaction and settles its final in %s",
    async (sessionKey) => {
      const runId = "background-check";
      const timestamp = Date.now();
      const session = {
        key: sessionKey,
        sessionId: "background-session",
        kind: "direct",
        status: "running",
        hasActiveRun: true,
        activeRunIds: [runId],
        updatedAt: timestamp,
      };
      const messages = [
        {
          role: "assistant",
          content: "The workspace check is continuing.",
          stopReason: "stop",
          timestamp: timestamp - 3000,
          __openclaw: { id: "previous-answer", seq: 1, runId: "previous-run" },
        },
        {
          role: "system",
          timestamp: timestamp - 2000,
          __openclaw: {
            kind: "compaction",
            id: "compact",
            seq: 2,
            tokensBefore: 251440,
            tokensAfter: 67702,
          },
        },
        {
          role: "assistant",
          stopReason: "toolUse",
          timestamp: timestamp - 1000,
          content: [
            { type: "toolCall", id: "inspect", name: "read", arguments: { path: "README.md" } },
          ],
          __openclaw: { id: "tool-call", seq: 3, runId },
        },
        {
          role: "toolResult",
          toolCallId: "inspect",
          toolName: "read",
          timestamp,
          content: [
            { type: "text", text: "Workspace inspection finished; continuing verification." },
          ],
          __openclaw: { id: "tool-result", seq: 4, runId },
        },
      ];
      const history = {
        messages,
        sessionId: session.sessionId,
        sessionInfo: session,
        inFlightRun: null,
      };
      const context = await suite.newBrowserContext({ viewport: { width: 1200, height: 900 } });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [session],
        historyMessages: messages,
        subscriptionInitialHistory: false,
        methodResponses: { "chat.startup": history, "chat.history": history },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const thread = page.locator(".chat-thread-inner");
      const savings = page.getByText("saved 183.7k tokens (73.1%)", { exact: true });
      const working = page.locator(".chat-working-indicator");
      await savings.waitFor();
      await working.waitFor();
      await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
      const frame = await takeControlUiScreenshotFrame(page, thread, [savings, working], {
        animations: "disabled",
      });
      await writeFile(
        join(
          suite.artifactDir,
          sessionKey === "agent:main:main" ? "background-running.png" : "dashboard-running.png",
        ),
        frame.png,
      );
      expect(await thread.getByText("Interrupted", { exact: true }).count()).toBe(0);
      expect((await gateway.getRequests("chat.send")).length).toBe(0);
      const final = {
        role: "assistant",
        content: "All checks completed successfully.",
        stopReason: "stop",
        timestamp: timestamp + 1000,
        __openclaw: { id: "final", seq: 5, runId, runTerminal: true },
      };
      const finishedSession = {
        ...session,
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: runId,
      };
      const finished = { ...history, messages: [...messages, final], sessionInfo: finishedSession };
      await gateway.setMethodResponse("chat.startup", finished);
      await gateway.setMethodResponse("chat.history", finished);
      await gateway.emitChatFinal({ runId, text: "All checks completed successfully." });
      await thread
        .locator(".chat-text")
        .getByText("All checks completed successfully.", { exact: true })
        .waitFor();
      await expect.poll(() => working.count()).toBe(0);
      expect(await thread.getByText("Interrupted", { exact: true }).count()).toBe(0);
    },
  );
});
