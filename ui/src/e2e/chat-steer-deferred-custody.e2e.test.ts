import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatHost } from "../pages/chat/chat-send-contract.ts";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedState } from "./settle.test-support.ts";
import { expectCount, expectVisible } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Deferred steering custody" });

async function verifyCustody(page: Page, previousRunSettled: boolean) {
  const sessionKey = "agent:main:main";
  const runId = "active-run";
  const timestamp = Date.now();
  const progress = "Checking the shared queue now.";
  const messages = [
    {
      role: "user",
      content: "Investigate the shared chat state",
      timestamp,
      __openclaw: { id: "original", seq: 1, idempotencyKey: runId + ":user" },
    },
  ];
  const sessionInfo = {
    key: sessionKey,
    sessionId: "session:" + sessionKey,
    kind: "direct",
    hasActiveRun: true,
    activeRunIds: [runId],
    status: "running",
    startedAt: timestamp,
  };
  const history = {
    ...prepareChatHistoryFixture(messages),
    sessionId: sessionInfo.sessionId,
    sessionInfo,
    inFlightRun: { runId, text: progress, startedAt: timestamp },
  };
  const gateway = await installMockGateway(page, {
    sessionKey,
    historyMessages: messages,
    sessionInfo,
    inFlightRun: history.inFlightRun,
  });
  await page.goto(`${suite.server.baseUrl}settings/appearance`);
  await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
  await page.locator("[data-settings-send-shortcut]").selectOption("enter");
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  const composer = page.locator(".agent-chat__input textarea");
  const stop = page.getByRole("button", { name: "Stop generating" });
  await stop.waitFor();
  await gateway.emitGatewayEvent("chat", {
    sessionKey,
    runId,
    state: "delta",
    message: { role: "assistant", content: progress },
  });
  await page.locator(".chat-bubble").getByText(progress, { exact: true }).waitFor();
  const correction = "This also happens outside Claude CLI";
  const bubble = page.locator(".chat-group.user", { hasText: correction });
  await composer.fill(correction);
  await gateway.deferNext("chat.send");
  await composer.press("Control+Enter");
  const queued = page.locator(".chat-queue__item", { hasText: correction });
  const sent = await gateway.waitForRequest("chat.send");
  expect(sent.params).toMatchObject({ queueMode: "steer" });
  const pendingRunId = (sent.params as { idempotencyKey: string }).idempotencyKey;
  const custodyRead = await gateway.deferNext("chat.history");
  // Custody exists at ACK; delivery of its history response remains independently held.
  const queuedHistory = {
    ...history,
    ...(previousRunSettled
      ? {
          sessionInfo: { ...sessionInfo, hasActiveRun: false, activeRunIds: [], status: "done" },
          inFlightRun: undefined,
        }
      : {}),
    inputReceipts: [{ runId: pendingRunId, state: "pending", queued: true }],
    pendingInputs: {
      items: [
        {
          id: "deferred-correction",
          runId: pendingRunId,
          acceptedAt: Date.now(),
          state: "queued",
          queued: true,
          message: { role: "user", content: correction, timestamp: Date.now() },
        },
      ],
      total: 1,
      queuedCount: 1,
    },
  };
  await gateway.setMethodResponse("chat.history", {
    ...queuedHistory,
    inputReceipts: [{ runId: pendingRunId, state: "pending" }],
    pendingInputs: {
      ...queuedHistory.pendingInputs,
      queuedCount: 0,
      items: queuedHistory.pendingInputs.items.map((input) => ({ ...input, queued: undefined })),
    },
  });
  if (previousRunSettled) {
    await gateway.emitChatFinal({ runId, sessionKey, text: "The original reply completed." });
    await expectCount(queued, 1);
    await expectCount(bubble, 0);
  }
  await gateway.resolveDeferred("chat.send", { runId: pendingRunId, status: "started" });
  await gateway.waitForRequest("chat.history", { after: custodyRead });
  await expectCount(queued, 1);
  await expectCount(bubble, 0);
  await gateway.resolveDeferred("chat.history");
  await waitForCommittedState(
    page,
    () => {
      const state = document.querySelector<HTMLElement & { state: ChatHost }>(
        "openclaw-chat-pane",
      )?.state;
      return state !== undefined && !state.chatSending;
    },
    undefined,
  );
  await expectCount(queued, 1);
  await expectCount(bubble, 0);
  await gateway.setMethodResponse("chat.history", queuedHistory);
  const reads = (await gateway.getRequests("chat.history")).length;
  await gateway.emitGatewayEvent("sessions.changed", {
    ...sessionInfo,
    sessionKey,
    reason: "agent.input.settled",
    updatedAt: Date.now(),
  });
  await gateway.waitForRequest("chat.history", { after: reads });
  await expectCount(queued, 1);
  await expectCount(bubble, 0);
  expect(await gateway.getRequests("chat.send")).toHaveLength(1);
  if (!previousRunSettled) {
    await expectVisible(stop);
  }
}

suite.define(() => {
  it.each([false, true])(
    "keeps a deferred steer queued through ACK and delayed custody (previous run settled: %s)",
    (previousRunSettled) =>
      suite.withPage({ viewport: { width: 393, height: 852 } }, ({ page }) =>
        verifyCustody(page, previousRunSettled),
      ),
  );
});
