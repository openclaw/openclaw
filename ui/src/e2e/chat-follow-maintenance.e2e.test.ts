import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:follow-maintenance";
const otherSessionKey = "agent:main:follow-control";
const runId = "follow-maintenance-run";
const streamMessage = (text: string, lines: number) => ({
  role: "assistant",
  content: `${text}\n${"Further output.\n".repeat(lines)}`,
});

async function readPosition(page: Page) {
  return page.locator(".chat-pane-cache__pane--active").evaluate((pane) => {
    const thread = pane.querySelector<HTMLElement>(".chat-thread")!;
    const { state } = pane as HTMLElement & { state: ChatPageHost };
    return {
      top: thread.scrollTop,
      height: thread.scrollHeight,
      distance: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
      locked: state.chatFollowLocked,
      reading: state.chatReadingHistory,
    };
  });
}

suite.define(() => {
  it("keeps following across concurrent row contraction, streaming growth and session navigation", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const position = () => readPosition(page);
        const historyMessages = Array.from({ length: 72 }, (_, index) => ({
          role: index % 12 === 0 ? "user" : "assistant",
          content: `Synthetic message ${index + 1}.`,
          timestamp: 1_750_000_000_000 + index * 1000,
          __openclaw: { id: `follow-message-${index}`, seq: index + 1 },
        }));
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages,
          inFlightRun: { runId, text: "Initial streamed output.\n".repeat(40) },
          sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
          sessions: [
            { key: sessionKey, kind: "direct", label: "Following session", updatedAt: 2 },
            { key: otherSessionKey, kind: "direct", label: "Control session", updatedAt: 1 },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByText("Synthetic message 72.", { exact: true }).waitFor();
        await waitForChatScrollIdle(page);
        await expect.poll(async () => (await position()).distance).toBeLessThanOrEqual(8);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");

        // Force a delayed media measurement in an overscan row above the viewport.
        await thread.evaluate((element) => {
          const top = element.getBoundingClientRect().top;
          const row = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].find(
            (candidate) => candidate.getBoundingClientRect().bottom < top,
          );
          if (!row) {
            throw new Error("Expected a mounted overscan row above the viewport");
          }
          row.style.contentVisibility = "visible";
          const filler = document.createElement("div");
          filler.id = "follow-delayed-measurement";
          filler.style.height = "200px";
          row.append(filler);
        });
        await waitForChatScrollIdle(page);
        const expanded = await position();

        // One task exposes maintenance offset as reader movement; separate tasks do not.
        await page.evaluate(
          ({ sessionKey: eventSessionKey, runId: eventRunId, message }) => {
            document.getElementById("follow-delayed-measurement")!.remove();
            const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway;
            if (!mock) {
              throw new Error("Expected the installed mock Gateway");
            }
            mock.emit("chat", {
              sessionKey: eventSessionKey,
              runId: eventRunId,
              state: "delta",
              message,
            });
          },
          { sessionKey, runId, message: streamMessage("Concurrent streaming growth.", 70) },
        );
        await expect.poll(() => thread.textContent()).toContain("Concurrent streaming growth.");
        await expect.poll(async () => (await position()).height).toBeGreaterThan(expanded.height);
        await waitForChatScrollIdle(page);

        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "delta",
          message: streamMessage("Latest streamed output.", 100),
        });
        await expect.poll(() => thread.textContent()).toContain("Latest streamed output.");
        await waitForChatScrollIdle(page);
        if (captureUiProofEnabled) {
          await page.screenshot({ path: path.join(suite.artifactDir, "stream-follow.png") });
        }
        expect(await position()).toMatchObject({ locked: false, reading: false });
        expect((await position()).distance).toBeLessThanOrEqual(8);

        const sessionLink = (key: string) =>
          page.locator(
            `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
          );
        const roundTrip = async () => {
          for (const key of [otherSessionKey, sessionKey]) {
            await sessionLink(key).click();
            await waitForChatScrollIdle(page);
          }
        };
        await roundTrip();
        expect((await position()).distance).toBeLessThanOrEqual(8);

        await thread.hover();
        await page.mouse.wheel(0, -600);
        await expect.poll(async () => (await position()).reading).toBe(true);
        await waitForChatScrollIdle(page);
        const reader = await position();
        await roundTrip();
        const restored = await position();
        expect(restored).toMatchObject({ locked: true, reading: true });
        expect(Math.abs(restored.top - reader.top)).toBeLessThanOrEqual(2);
        await page.getByRole("button", { name: "Scroll to latest", exact: true }).click();
        await expect.poll(async () => (await position()).distance).toBeLessThanOrEqual(8);
        expect(await position()).toMatchObject({ locked: false, reading: false });
      },
    );
  });
});
