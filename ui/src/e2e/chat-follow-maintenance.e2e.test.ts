import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:follow-maintenance";
const otherSessionKey = "agent:main:follow-control";
const runId = "follow-maintenance-run";

async function readPosition(page: Page) {
  return page.locator(".chat-pane-cache__pane--active").evaluate((pane) => {
    const thread = pane.querySelector<HTMLElement>(".chat-thread")!;
    const state = (
      pane as HTMLElement & {
        state: { chatFollowLocked: boolean; chatReadingHistory: boolean };
      }
    ).state;
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
          methodResponses: {
            "sessions.list": chatSessionListResponse([
              { key: sessionKey, kind: "direct", label: "Following session", updatedAt: 2 },
              { key: otherSessionKey, kind: "direct", label: "Control session", updatedAt: 1 },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByText("Synthetic message 72.", { exact: true }).waitFor();
        await waitForChatScrollIdle(page);
        await expect.poll(async () => (await readPosition(page)).distance).toBeLessThanOrEqual(8);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");

        // Reproduce a delayed card/media measurement above the viewport. Force
        // this overscan row to participate in layout despite content-visibility.
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
        const expanded = await readPosition(page);

        // Both changes must share one task. Separate shrink/growth settles at
        // the end and does not expose a maintenance offset as reader movement.
        await page.evaluate(
          ({ sessionKey: eventSessionKey, runId: eventRunId }) => {
            document.getElementById("follow-delayed-measurement")!.remove();
            const mock = (
              window as Window & {
                openclawControlUiE2eGateway?: {
                  emit: (event: string, payload: unknown) => void;
                };
              }
            ).openclawControlUiE2eGateway;
            if (!mock) {
              throw new Error("Expected the installed mock Gateway");
            }
            mock.emit("chat", {
              sessionKey: eventSessionKey,
              runId: eventRunId,
              state: "delta",
              message: {
                role: "assistant",
                content: "Concurrent streaming growth.\n" + "Further output.\n".repeat(70),
              },
            });
          },
          { sessionKey, runId },
        );
        await expect.poll(() => thread.textContent()).toContain("Concurrent streaming growth.");
        await expect
          .poll(async () => (await readPosition(page)).height)
          .toBeGreaterThan(expanded.height);
        await waitForChatScrollIdle(page);

        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "delta",
          message: {
            role: "assistant",
            content: "Latest streamed output.\n" + "Further output.\n".repeat(100),
          },
        });
        await expect.poll(() => thread.textContent()).toContain("Latest streamed output.");
        await waitForChatScrollIdle(page);
        if (captureUiProofEnabled) {
          await page.screenshot({ path: path.join(suite.artifactDir, "stream-follow.png") });
        }
        expect(await readPosition(page)).toMatchObject({ locked: false, reading: false });
        expect((await readPosition(page)).distance).toBeLessThanOrEqual(8);

        const sessionLink = (key: string) =>
          page.locator(
            `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
          );
        await sessionLink(otherSessionKey).click();
        await waitForChatScrollIdle(page);
        await sessionLink(sessionKey).click();
        await waitForChatScrollIdle(page);
        expect((await readPosition(page)).distance).toBeLessThanOrEqual(8);

        await thread.hover();
        await page.mouse.wheel(0, -600);
        await expect.poll(async () => (await readPosition(page)).reading).toBe(true);
        await waitForChatScrollIdle(page);
        const reader = await readPosition(page);
        await sessionLink(otherSessionKey).click();
        await waitForChatScrollIdle(page);
        await sessionLink(sessionKey).click();
        await waitForChatScrollIdle(page);
        const restored = await readPosition(page);
        expect(restored).toMatchObject({ locked: true, reading: true });
        expect(Math.abs(restored.top - reader.top)).toBeLessThanOrEqual(2);
        await page.getByRole("button", { name: "Scroll to latest", exact: true }).click();
        await expect.poll(async () => (await readPosition(page)).distance).toBeLessThanOrEqual(8);
        expect(await readPosition(page)).toMatchObject({ locked: false, reading: false });
      },
    );
  });
});
