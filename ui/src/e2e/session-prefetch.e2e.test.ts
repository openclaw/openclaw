import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/chat-pane-elements.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { expectTranscriptLayoutCommitted } from "./claude-sessions.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("opens the full prefetched history window without a refill jump after a roster refresh", async () => {
    const reportKey = "agent:main:weekly-report";
    const workKey = "agent:main:workspace";
    const report = createControlUiSessionRow(reportKey, "Weekly report", 1);
    const workspace = createControlUiSessionRow(workKey, "Workspace", 2);
    const reportMessages = Array.from({ length: 80 }, (_, index) =>
      chatMessage(
        index % 2 === 0 ? "user" : "assistant",
        `Report item ${index + 1}\n\n${"Synthetic weekly report detail. ".repeat(65)}`,
        { __openclaw: { id: `report-${index + 1}`, seq: index + 1 } },
      ),
    );
    const reportHistory = {
      completeSnapshot: true,
      hasMore: false,
      messages: reportMessages,
      sessionId: report.sessionId,
    };
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        subscriptionInitialHistory: false,
        sessionKey: workKey,
        deferredMethods: ["chat.history"],
        methodResponses: { "sessions.list": sessionsListResponse([workspace, report]) },
        sessionTranscripts: {
          [workKey]: { messages: [{ role: "assistant", content: "Workspace ready." }] },
          [reportKey]: reportHistory,
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, workKey));
      await page.locator(".chat-thread-inner").getByText("Workspace ready.").waitFor();
      const requests = gateway.getRequests;
      expect(await requests("chat.startup")).toHaveLength(1);
      const reportTarget = { sessionKey: reportKey };
      const reportLink = page
        .locator(`openclaw-app-sidebar [data-session-key="${reportKey}"] a`)
        .first();
      await reportLink.hover();
      await expect.poll(async () => (await requests("chat.history", reportTarget)).length).toBe(1);
      expect(await requests("chat.startup")).toHaveLength(1);
      const before = (await requests("sessions.list")).length;
      await gateway.setSessionsListResponse(
        sessionsListResponse([{ ...workspace, label: "Workspace updated", updatedAt: 3 }, report]),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: workKey,
        reason: "update",
        updatedAt: 3,
      });
      await expect
        .poll(async () => (await requests("sessions.list")).length)
        .toBeGreaterThan(before);
      await expect
        .poll(() =>
          page.locator(`openclaw-app-sidebar [data-session-key="${workKey}"]`).textContent(),
        )
        .toContain("Workspace updated");
      // Model a server honoring both limits. Either a smaller count or a smaller
      // byte budget must reproduce a partial warm snapshot, not an always-full mock.
      const warmRequest = (await requests("chat.history", reportTarget))[0]!;
      const { limit, maxBytes } = warmRequest.params as { limit: number; maxBytes: number };
      const warmMessages: typeof reportMessages = [];
      for (const message of reportMessages.toReversed().slice(0, limit)) {
        if (Buffer.byteLength(JSON.stringify([message, ...warmMessages])) > maxBytes) {
          break;
        }
        warmMessages.unshift(message);
      }
      await gateway.resolveDeferred("chat.history", {
        ...reportHistory,
        messages: warmMessages,
        hasMore: warmMessages.length < reportMessages.length,
        ...(warmMessages.length < reportMessages.length ? { olderCursor: "older-report" } : {}),
        nextOffset: warmMessages.length,
      });
      const emptyReport = { messages: [], sessionId: report.sessionId };
      await gateway.setMethodResponse("chat.history", emptyReport);
      await gateway.setMethodResponse("chat.startup", emptyReport);
      await gateway.deferNext("chat.history", reportTarget);
      await gateway.deferNext("chat.startup", reportTarget);
      await reportLink.click();
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const thread = pane.locator(".chat-thread");
      await pane.getByText(/^Report item 80\b/).waitFor();
      await expectTranscriptLayoutCommitted(thread);
      await thread.evaluate((element) => {
        element.scrollTop = 0;
      });
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const directory = createControlUiE2eArtifactDir("session-prefetch-window");
        const frame = await takeControlUiScreenshotFrame(
          page,
          thread,
          [thread.locator(".chat-text").first()],
          { animations: "disabled" },
        );
        await writeFile(path.join(directory, "opened-history.png"), frame.png);
      }
      const first = pane.getByText(/^Report item 1\b/).first();
      await first.waitFor();
      const anchorBefore = await first.boundingBox();
      expect((await requests("chat.startup", reportTarget)).length).toBeGreaterThan(0);
      await gateway.resolveDeferred("chat.startup", reportHistory);
      await expect
        .poll(() => pane.evaluate((element: ChatPaneElement) => element.transcriptLoading))
        .toBe(false);
      await expectTranscriptLayoutCommitted(thread);
      await expect.poll(async () => (await first.boundingBox())?.y).toBe(anchorBefore?.y);
      expect(
        await requests("chat.history", { ...reportTarget, cursor: "older-report" }),
      ).toHaveLength(0);
    });
  });
});
