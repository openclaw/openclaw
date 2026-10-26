import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Stale chat busy follow-up" });
const sessionKey = "agent:main:stale-busy";
const runId = "missed-terminal-run";
const sessionId = "stale-busy-session";
const reply = "The previous request completed.";
const followUp = "Continue with the next request.";
const active = {
  key: sessionKey,
  sessionId,
  kind: "direct",
  label: "Stale busy recovery",
  updatedAt: 1,
  hasActiveRun: true,
  activeRunIds: [runId],
  status: "running",
};
const idle = {
  ...active,
  updatedAt: 2,
  hasActiveRun: false,
  activeRunIds: [],
  lastRunId: runId,
  status: "done",
};
const completed = {
  sessionId,
  sessionInfo: idle,
  messages: [{ role: "assistant", content: reply }],
  inFlightRun: null,
};

suite.define(() => {
  it("delivers a queued follow-up after a missed terminal without refreshing the browser", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await page.clock.install();
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [active],
        sessionInfo: active,
        inFlightRun: { runId, text: "Working on the previous request." },
      });
      await page.goto(suite.server.baseUrl + "settings/appearance");
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const stop = page.getByRole("button", { name: "Stop generating", exact: true });
      await stop.waitFor();
      await pauseVirtualClock(page);
      // Only the next authoritative snapshots change; no terminal event reaches this page.
      await gateway.setMethodResponse("chat.history", completed);
      await gateway.setMethodResponse("chat.startup", completed);
      await gateway.setSessionsListResponse({ ts: 2, count: 1, sessions: [idle] });

      const freshContext = await suite.newBrowserContext({
        viewport: { width: 1280, height: 900 },
      });
      const fresh = await freshContext.newPage();
      await installMockGateway(fresh, {
        sessionKey,
        sessions: [idle],
        sessionInfo: idle,
        historyMessages: completed.messages,
      });
      await fresh.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await fresh.getByText(reply, { exact: true }).waitFor();
      expect(
        await fresh.getByRole("button", { name: "Stop generating", exact: true }).count(),
      ).toBe(0);
      await suite.closeBrowserContext(freshContext);

      await page.locator(".agent-chat__input textarea").fill(followUp);
      await page.getByRole("button", { name: "Queue message", exact: true }).click();
      await page.clock.resume();
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({ sessionKey, message: followUp });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await page.locator(".chat-group.user").getByText(followUp, { exact: true }).waitFor();
      expect(await page.locator(".chat-queue__item").count()).toBe(0);
      expect(
        await page.getByText("Working on the previous request.", { exact: true }).count(),
      ).toBe(0);
      await page.screenshot({ path: suite.artifactDir + "/recovered-without-refresh.png" });
    });
  });
});
