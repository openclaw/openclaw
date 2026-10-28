import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  textContent,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import {
  type AnchorWindow,
  historyMessageCount,
  sampleHistoryAnchor,
} from "./chat-history-pagination-probe.test-support.ts";
import { layoutBox, twoFrames } from "./chat-presentation.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("recalls older prompts after returning to the draft", async () => {
    const page = await newChatPage(suite, {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const prompts: Record<number, string> = {
      1: "Earlier prompt",
      3: "Recent prompt",
      81: "Latest prompt",
    };
    const message = (seq: number) => ({
      __openclaw: { id: `recall-${seq}`, seq },
      role: prompts[seq] ? "user" : "assistant",
      content: textContent(
        prompts[seq] ?? `History entry ${seq}. ${"History detail. ".repeat(20)}`,
      ),
      timestamp: 1_800_000_000_000 + seq,
    });
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
      sessions: [{ key: "agent:main:main", sessionId: "recall-session" }],
      methodResponses: {
        "chat.startup": {
          messages: Array.from({ length: 80 }, (_, index) => message(index + 3)),
          hasMore: true,
          nextOffset: 80,
          totalMessages: 82,
          sessionId: "recall-session",
        },
        "chat.history": {
          messages: [message(1), message(2)],
          hasMore: false,
          totalMessages: 82,
          sessionId: "recall-session",
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const pane = page.locator(".chat-pane-cache__pane--active");
    const thread = pane.locator(".chat-thread");
    const textarea = pane.locator(".agent-chat__composer-combobox textarea");
    await thread.getByText(/^History entry 82\./).waitFor();
    await waitForChatScrollIdle(page);
    expect(await gateway.getRequests("chat.history")).toHaveLength(0);
    await textarea.press("ArrowUp");
    await expect.poll(() => textarea.inputValue()).toBe("Latest prompt");
    await textarea.press("ArrowDown");
    await expect.poll(() => textarea.inputValue()).toBe("");

    await gateway.deferNext("chat.history");
    await thread.hover();
    await page.mouse.wheel(0, -1_000_000);
    await waitForRequests(gateway, "chat.history", 1);
    await gateway.resolveDeferred("chat.history");
    await waitForChatScrollIdle(page);
    await thread.hover();
    await page.mouse.wheel(0, -1_000_000);
    await thread.getByText("Earlier prompt", { exact: true }).waitFor();
    const requests = await gateway.getRequests("chat.history");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toMatchObject({ offset: 80 });
    await textarea.press("ArrowUp");
    await expect.poll(() => textarea.inputValue()).toBe("Latest prompt");
    await textarea.press("ArrowUp");
    await expect.poll(() => textarea.inputValue()).toBe("Recent prompt");
    await textarea.press("ArrowUp");
    await expect.poll(() => textarea.inputValue()).toBe("Earlier prompt");
    await textarea.press("ArrowDown");
    await expect.poll(() => textarea.inputValue()).toBe("Recent prompt");
    await textarea.press("ArrowDown");
    await expect.poll(() => textarea.inputValue()).toBe("Latest prompt");
    await textarea.press("ArrowDown");
    await expect.poll(() => textarea.inputValue()).toBe("");
  });

  {
    const historyPage = (messages: unknown[], nextOffset: number) => ({
      messages,
      nextOffset,
      hasMore: true,
      totalMessages: 2072,
      sessionId: "activity-history",
    });

    it.each([
      { width: 1440, split: false },
      { width: 390, split: false },
      { width: 1440, split: true },
    ])("anchors coalesced activity at $width px (split=$split)", async ({ width, split }) => {
      const page = await newChatPage(suite, {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width, height: 900 },
      });
      const activity = (seq: number) => ({
        __openclaw: { id: `activity-${seq}`, seq, runId: `wake-${seq}` },
        role: "toolResult",
        toolCallId: `call-${seq}`,
        toolName: "read",
        content: textContent("Synthetic check completed."),
        timestamp: 1_800_000_000_000 + seq,
      });
      const recent = [
        ...Array.from({ length: 20 }, (_, index) => activity(1001 + index)),
        ...Array.from({ length: 52 }, (_, index) => ({
          __openclaw: { id: `message-${index}`, seq: 1021 + index },
          role: index % 2 ? "assistant" : "user",
          content: textContent(`Retained message ${index}. ${"History detail. ".repeat(8)}`),
          timestamp: 1_800_000_001_021 + index,
        })),
      ];
      const gateway = await installMockGateway(page, {
        sessions: [{ key: "agent:main:main", sessionId: "activity-history" }],
        heldMethods: ["chat.history"],
        methodResponses: {
          "chat.startup": historyPage(recent, 72),
          "chat.history": historyPage(
            Array.from({ length: 1000 }, (_, index) => activity(index + 1)),
            1072,
          ),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      let pane = page.locator(".chat-pane-cache__pane--active");
      let thread = pane.locator(".chat-thread");
      await thread.getByText(/^Retained message 51\./).waitFor();
      if (split) {
        await selectChatLayoutAction(pane, "Open split view");
        const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
        await expect.poll(() => panes.count()).toBe(2);
        pane = panes.nth(1);
        thread = pane.locator(".chat-thread");
        await thread.getByText(/^Retained message 51\./).waitFor();
      }
      await thread.hover();
      await page.mouse.wheel(0, -100_000);
      await gateway.waitForRequest("chat.history", {
        match: { sessionKey: "agent:main:main", offset: 72 },
      });
      await waitForChatScrollIdle(page);
      // Let virtualization settle, then anchor the same retained bubble before delivery.
      const anchor = thread.locator(".chat-bubble").filter({ hasText: "Retained message 0." });
      await expect.poll(() => anchor.isVisible()).toBe(true);
      await page.keyboard.press("Home");
      await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
      const count = () => historyMessageCount(pane);
      expect(await count()).toBe(72);
      const before = await layoutBox(anchor);
      expect(before.y).toBeGreaterThan(0);
      const probe = await sampleHistoryAnchor(anchor);
      if (split) {
        const sibling = page.locator("openclaw-chat-pane.chat-split-view__pane").nth(0);
        await sibling.locator(".chat-pane__header").click();
        await expect
          .poll(() => pane.getAttribute("class"))
          .not.toContain("chat-pane-cache__pane--active");
      }
      await gateway.deferNext("chat.history");
      await gateway.resolveDeferred("chat.history");
      await expect.poll(count).toBe(1072);
      await twoFrames(page);
      const tops = await probe.evaluate((stop) => stop());
      await probe.dispose();
      expect(tops.length).toBeGreaterThan(1);
      expect(
        tops.every((top) => top !== null),
        "anchor stays mounted",
      ).toBe(true);
      const displacement = Math.max(...tops.map((top) => Math.abs(top! - before.y)));
      expect(displacement, "each frame must preserve the reading position").toBeLessThanOrEqual(1);
      expect(Math.abs((await anchor.boundingBox())!.y - before.y)).toBeLessThanOrEqual(1);
    });
  }
  {
    function touchGesture(
      element: Element,
      { start, momentum }: { start: boolean; momentum: boolean },
    ) {
      const thread = element as HTMLElement;
      const move = (delta: number) => {
        (window as AnchorWindow).prependFrames.readerDelta += delta;
        thread.scrollTop += delta;
        thread.dispatchEvent(new Event("scroll"));
      };
      if (start && momentum) {
        // Model browsers that release momentum through idle, not scrollend.
        thread.addEventListener("scrollend", (event) => event.stopImmediatePropagation(), {
          capture: true,
        });
      }
      if (!start && momentum) {
        move(10);
      }
      const contact = [new Touch({ identifier: 1, target: thread })];
      thread.dispatchEvent(
        new TouchEvent(start ? "touchstart" : "touchend", {
          changedTouches: contact,
          bubbles: true,
          ...(start ? { touches: contact, targetTouches: contact } : {}),
        }),
      );
      // End-contact movement, release and momentum stay in one browser task.
      if (momentum) {
        move(start ? 20 : 10);
      }
    }

    it.each(
      [
        {},
        { sharedGroup: true },
        { manual: true },
        { sharedGroup: true, manual: true },
        { sharedGroup: true, onlyGroup: true },
        { sharedGroup: true, onlyGroup: true, more: true },
        { sharedGroup: true, onlyGroup: true, persisted: false },
        { sharedGroup: true, more: true, activeTouch: true },
        { sharedGroup: true, more: true, activeTouch: true, momentum: true },
      ].map((row) =>
        Object.assign({ sharedGroup: false, manual: false, onlyGroup: false, more: false }, row),
      ),
    )(
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
        const page = await newChatPage(suite, {
          locale: "en-US",
          serviceWorkers: "block",
          hasTouch: activeTouch,
          userAgent: activeTouch
            ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
            : undefined,
          viewport: { height: 900, width: 1280 },
        });
        const detail = "History detail for the reader. ".repeat(8);
        const message = (seq: number) => ({
          __openclaw: { ...(persisted ? { id: `prepend-${seq}` } : {}), seq },
          role:
            sharedGroup && seq >= 995 && seq <= 1005 ? "assistant" : seq % 2 ? "user" : "assistant",
          content: [{ type: "text", text: `Transcript entry ${seq}. ${detail}` }],
          timestamp: 1_800_000_000_000 + seq,
        });
        const recent = Array.from({ length: 800 }, (_, index) => message(index + 1001));
        const older = Array.from({ length: onlyGroup ? 6 : 1000 }, (_, index) =>
          message(index + (onlyGroup ? 995 : 1)),
        );
        const loadedCount = recent.length + older.length;
        const totalMessages = loadedCount + (more ? 10 : 0);
        const history = (messages: typeof recent, hasMore: boolean, nextOffset: number) => ({
          messages,
          hasMore,
          nextOffset,
          totalMessages,
          sessionId: "prepend-session",
        });
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          sessions: [{ key: "agent:main:main", sessionId: "prepend-session" }],
          methodResponses: {
            "chat.startup": history(recent, true, 800),
            "chat.history": history(older, more, loadedCount),
          },
        });
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
          // Failed auto-loading exposes retry without another upward gesture.
          await gateway.rejectDeferred("chat.history", {
            message: "History temporarily unavailable",
          });
          const showEarlier = thread.getByRole("button", {
            name: "Retry earlier messages",
            exact: true,
          });
          await expect.poll(() => showEarlier.isEnabled()).toBe(true);
          await gateway.deferNext("chat.history");
          await showEarlier.click();
          await waitForRequests(gateway, "chat.history", 2);
        }
        await waitForChatScrollIdle(page);
        const anchor = thread.locator(".chat-bubble").filter({ hasText: "Transcript entry 1001." });
        await anchor.waitFor();
        const before = await layoutBox(anchor);
        const probe = await sampleHistoryAnchor(anchor);
        const scrollTop = () => thread.evaluate((element) => element.scrollTop);
        const heldOffset = await scrollTop();
        if (activeTouch) {
          await thread.evaluate(touchGesture, { start: true, momentum });
        }
        await gateway.resolveDeferred("chat.history");
        await expect.poll(() => historyMessageCount(pane)).toBe(loadedCount);
        if (activeTouch) {
          await twoFrames(page); // Let the projection commit before checking touch deferral.
          expect(
            await scrollTop(),
            "a history prepend must not write the scroll offset during an active touch",
          ).toBe(heldOffset + (momentum ? 20 : 0));
          await thread.evaluate(touchGesture, { start: false, momentum });
        }
        await waitForChatScrollIdle(page);
        // Require the fetched page to reach the viewport, not just pane state.
        await expect.poll(scrollTop).toBeGreaterThan(heldOffset + (momentum ? 40 : 0) + 100);
        const frames = await probe.evaluate((stop) => stop());
        await probe.dispose();
        const after = await layoutBox(anchor);
        expect(
          Math.abs(after.y + (momentum ? 40 : 0) - before.y),
          "loading older history must not move the message being read",
        ).toBeLessThanOrEqual(2);
        expect(frames.length).toBeGreaterThan(1);
        expect(
          frames.every((top) => top !== null && Math.abs(top - before.y) <= 2),
          "the message must stay anchored at every animation frame, not just after settling",
        ).toBe(true);
        if (!more && !onlyGroup) {
          await thread.hover();
          await page.mouse.wheel(0, -1_000_000);
          await waitForChatScrollIdle(page);
          const first = thread.getByText(/^Transcript entry 1\./);
          await first.waitFor();
          const firstBox = await layoutBox(first);
          const viewport = await layoutBox(thread);
          expect(firstBox.y).toBeGreaterThanOrEqual(viewport.y - 2);
          expect(firstBox.y).toBeLessThan(viewport.y + viewport.height);
          await pane.locator(".chat-history-sentinel").waitFor({ state: "detached" });
          expect((await gateway.getRequests("chat.history")).length).toBe(manual ? 2 : 1);
        }
      },
    );
  }
  {
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
          const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
          await thread.getByText("Initial streamed output.", { exact: false }).waitFor();
          // The long live tail leaves earlier rows unmounted until reader navigation.
          await thread.hover();
          await page.mouse.wheel(0, -120);
          await page.getByText("Synthetic message 72.", { exact: true }).waitFor();
          await page.getByRole("button", { name: "Scroll to latest", exact: true }).click();
          await waitForChatScrollIdle(page);
          await expect.poll(async () => (await position()).distance).toBeLessThanOrEqual(8);

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
            row.style.contain = "none";
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
  }
});
