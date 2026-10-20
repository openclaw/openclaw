import { expect, it } from "vitest";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat session prefetch gating",
  startServerBeforeBrowser: true,
});

const MAIN_SESSION_KEY = "agent:main:main";
const WARM_SESSION_KEY = "agent:main:warm-later";
const CLOCK_START = Date.UTC(2026, 8, 3, 12, 0, 0);

function transcript(text: string, seq: number) {
  return {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: CLOCK_START - 60_000 + seq,
        __openclaw: { id: `msg-${seq}`, seq },
      },
    ],
  };
}

suite.define(() => {
  it("keeps queued warm-ups off the socket while the presented transcript reloads", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.clock.install({ time: CLOCK_START });
    const mainSession = createControlUiSessionRow(MAIN_SESSION_KEY, "Main", CLOCK_START - 1_000);
    const gateway = await installMockGateway(page, {
      // Startup serves the foreground; navigation warms through chat.history.
      deferredMethods: ["chat.history"],
      historyMessages: [],
      sessions: [
        mainSession,
        createControlUiSessionRow(WARM_SESSION_KEY, "Warm later", CLOCK_START - 2_000),
      ],
      sessionTranscripts: {
        [MAIN_SESSION_KEY]: transcript("Main transcript", 1),
        [WARM_SESSION_KEY]: transcript("Warm transcript", 2),
      },
    });
    const historyRequestCount = async (sessionKey: string) =>
      (await gateway.getRequests("chat.history")).filter(
        ({ params }) => (params as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
      ).length;
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await page.locator(".chat-bubble", { hasText: "Main transcript" }).first().waitFor();
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await page
        .locator(`openclaw-app-sidebar [data-session-key="${WARM_SESSION_KEY}"] a`)
        .first()
        .hover();
      await expect.poll(() => historyRequestCount(WARM_SESSION_KEY)).toBe(1);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      // Non-retryable rejection leaves only the prefetch cooldown responsible for retry.
      await gateway.rejectDeferred("chat.history", { code: "UNAVAILABLE", message: "warm later" });

      // Hold the pane-owned reload triggered by a peer message.
      await gateway.deferNext("chat.history", { sessionKey: MAIN_SESSION_KEY });
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: MAIN_SESSION_KEY,
        session: mainSession,
        message: {
          role: "user",
          content: [{ type: "text", text: "Peer message arrived." }],
          __openclaw: { id: "peer-message", seq: 5 },
        },
        messageId: "peer-message",
        messageSeq: 5,
      });
      await expect.poll(() => historyRequestCount(MAIN_SESSION_KEY)).toBe(1);
      // Hold the replacement foreground read after its 30-second deadline too.
      await gateway.deferNext("chat.history", { sessionKey: MAIN_SESSION_KEY });

      // Fire prefetch cooldowns while the foreground transcript is in flight.
      await pauseVirtualClock(page);
      await page.clock.runFor(35_000);
      expect(await historyRequestCount(WARM_SESSION_KEY)).toBe(1);
      expect(await historyRequestCount(MAIN_SESSION_KEY)).toBe(2);
      await gateway.resolveDeferred("chat.history", {
        ...transcript("Retired foreground response", 6),
        sessionId: mainSession.sessionId,
      });
      await page.clock.runFor(1);
      expect(await page.getByText("Retired foreground response", { exact: true }).count()).toBe(0);
      expect(await historyRequestCount(WARM_SESSION_KEY)).toBe(1);

      // Only the current foreground response commits; warming then resumes on its own.
      await gateway.resolveDeferred("chat.history", {
        ...transcript("Main transcript reloaded", 6),
        sessionId: mainSession.sessionId,
      });
      await page.locator(".chat-bubble", { hasText: "Main transcript reloaded" }).first().waitFor();
      await page.clock.runFor(35_000);
      await expect.poll(() => historyRequestCount(WARM_SESSION_KEY)).toBe(2);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
