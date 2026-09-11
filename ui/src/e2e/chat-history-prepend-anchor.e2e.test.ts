import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
type AnchorFrames = { frame: number; positions: Array<number | null>; readerDelta: number };
type AnchorWindow = typeof window & { prependFrames: AnchorFrames };

suite.define(() => {
  it.each([
    { sharedGroup: false, manual: false, onlyGroup: false, more: false },
    { sharedGroup: true, manual: false, onlyGroup: false, more: false },
    { sharedGroup: false, manual: true, onlyGroup: false, more: false },
    { sharedGroup: true, manual: true, onlyGroup: false, more: false },
    { sharedGroup: true, manual: false, onlyGroup: true, more: false },
    { sharedGroup: true, manual: false, onlyGroup: true, more: true },
    { sharedGroup: true, manual: false, onlyGroup: true, more: false, persisted: false },
    { sharedGroup: true, manual: false, onlyGroup: false, more: true, activeTouch: true },
    {
      sharedGroup: true,
      manual: false,
      onlyGroup: false,
      more: true,
      activeTouch: true,
      momentum: true,
    },
  ])(
    "anchors history prepend (shared=$sharedGroup, manual=$manual, onlyGroup=$onlyGroup, more=$more, persisted=$persisted, touch=$activeTouch, momentum=$momentum)",
    async ({
      sharedGroup,
      manual,
      onlyGroup,
      more,
      persisted = true,
      activeTouch = false,
      momentum = false,
    }) => {
      const artifactDir = createControlUiE2eArtifactDir("chat-history-prepend-anchor");
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        hasTouch: activeTouch,
        ...(activeTouch
          ? {
              userAgent:
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
            }
          : {}),
        viewport: { height: 900, width: 1280 },
        recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
      });
      const page = await context.newPage();
      const message = (seq: number) => ({
        __openclaw: { ...(persisted ? { id: `prepend-${seq}` } : {}), seq },
        role:
          sharedGroup && seq >= 995 && seq <= 1005 ? "assistant" : seq % 2 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: `Transcript entry ${seq}. ${"History detail for the reader. ".repeat(8)}`,
          },
        ],
        timestamp: 1_800_000_000_000 + seq,
      });
      const recent = Array.from({ length: 800 }, (_, index) => message(index + 1001));
      const older = Array.from({ length: onlyGroup ? 6 : 1000 }, (_, index) =>
        message(index + (onlyGroup ? 995 : 1)),
      );
      const loadedCount = recent.length + older.length;
      const totalMessages = loadedCount + (more ? 10 : 0);
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        sessions: [{ key: "agent:main:main", sessionId: "prepend-session" }],
        methodResponses: {
          "chat.startup": {
            messages: recent,
            hasMore: true,
            nextOffset: 800,
            totalMessages,
            sessionId: "prepend-session",
          },
          "chat.history": {
            messages: older,
            hasMore: more,
            nextOffset: loadedCount,
            totalMessages,
            sessionId: "prepend-session",
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const pane = page.locator(".chat-pane-cache__pane--active");
        const thread = pane.locator(".chat-thread");
        await thread.getByText(/^Transcript entry 1800\./).waitFor();
        await waitForChatScrollIdle(page);
        await gateway.deferNext("chat.history");
        await thread.hover();
        await page.mouse.wheel(0, -1_000_000);
        await waitForRequests(gateway, "chat.history", 1);
        if (manual) {
          // A failed automatic load exposes the explicit retry control without
          // another upward gesture consuming history before the reader clicks.
          await gateway.rejectDeferred("chat.history", {
            message: "History temporarily unavailable",
          });
          const showEarlier = thread.getByRole("button", { name: "Show earlier", exact: true });
          await expect.poll(() => showEarlier.isEnabled()).toBe(true);
          await gateway.deferNext("chat.history");
          await showEarlier.click();
          await waitForRequests(gateway, "chat.history", 2);
        }
        await waitForChatScrollIdle(page);
        const anchor = thread.locator(".chat-bubble").filter({ hasText: "Transcript entry 1001." });
        await anchor.waitFor();
        const before = await anchor.boundingBox();
        expect(before).not.toBeNull();
        await page.screenshot({ path: path.join(artifactDir, "before-prepend.png") });
        await page.evaluate(
          (messageKey) => {
            const frames: AnchorFrames = { frame: 0, positions: [], readerDelta: 0 };
            (window as AnchorWindow).prependFrames = frames;
            const sample = () => {
              const bubble = [
                ...document.querySelectorAll<HTMLElement>(
                  ".chat-pane-cache__pane--active .chat-bubble[data-message-id]",
                ),
              ].find((element) => element.dataset.messageId === messageKey);
              frames.positions.push(
                bubble ? bubble.getBoundingClientRect().top + frames.readerDelta : null,
              );
              frames.frame = requestAnimationFrame(sample);
            };
            sample();
          },
          await anchor.getAttribute("data-message-id"),
        );
        const heldOffset = await thread.evaluate((element) => element.scrollTop);
        if (activeTouch) {
          if (momentum) {
            // Chromium emits scrollend itself; suppress delivery to model
            // browsers that only provide the offset observer's idle callback.
            await thread.evaluate((element) =>
              element.addEventListener("scrollend", (event) => event.stopImmediatePropagation(), {
                capture: true,
              }),
            );
          }
          await thread.dispatchEvent("touchstart");
          if (momentum) {
            await thread.evaluate((element) => {
              (window as AnchorWindow).prependFrames.readerDelta += 20;
              element.scrollTop += 20;
              element.dispatchEvent(new Event("scroll"));
            });
          }
        }
        await gateway.resolveDeferred("chat.history");
        await expect
          .poll(() =>
            pane.evaluate(
              (element) =>
                (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                  .length,
            ),
          )
          .toBe(loadedCount);
        if (activeTouch) {
          // Let the real projection commit before checking that compensation
          // respects the dependency's active-touch deferral.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          expect(
            await thread.evaluate((element) => element.scrollTop),
            "a history prepend must not write the scroll offset during an active touch",
          ).toBe(heldOffset + (momentum ? 20 : 0));
          await thread.dispatchEvent("touchend");
          if (momentum) {
            // Synthetic offset events protect ownership ordering, not native
            // Safari inertia. Natural reader movement is removed from samples.
            await thread.evaluate((element) => {
              (window as AnchorWindow).prependFrames.readerDelta += 20;
              element.scrollTop += 20;
              element.dispatchEvent(new Event("scroll"));
            });
            // Deliberately omit scrollend: the offset observer must release history.
          }
        }
        await waitForChatScrollIdle(page);
        // State can contain the fetched page while the rendered projection is
        // still held. Require its added extent to reach the native viewport.
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(heldOffset + (momentum ? 40 : 0) + 100);
        await page.screenshot({ path: path.join(artifactDir, "after-prepend.png") });
        const frames = await page.evaluate(() => {
          const probe = (window as AnchorWindow).prependFrames;
          cancelAnimationFrame(probe.frame);
          return probe.positions;
        });
        const after = await anchor.boundingBox();
        console.log(
          JSON.stringify({
            sharedGroup,
            manual,
            onlyGroup,
            more,
            before,
            after,
            frames,
            artifactDir,
          }),
        );
        expect(after, "the message being read must remain rendered").not.toBeNull();
        expect(
          Math.abs(after!.y + (momentum ? 40 : 0) - before!.y),
          "loading older history must not move the message being read",
        ).toBeLessThanOrEqual(2);
        expect(frames.length).toBeGreaterThan(1);
        expect(
          frames.every((top) => top !== null && Math.abs(top - before!.y) <= 2),
          "the message must stay anchored at every animation frame, not just after settling",
        ).toBe(true);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
