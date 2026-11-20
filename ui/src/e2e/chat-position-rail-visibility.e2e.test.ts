import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  chatMessage,
  newChatPage,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("restores final rail highlights at full opacity with the first cached transcript frame", async () => {
    const page = await newChatPage(suite, {
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const sessionKey = "agent:main:chat:rail-restore";
    const session = createControlUiSessionRow(sessionKey, "Synthetic rail restore", 1, {
      archived: true,
    });
    const gateway = await installMockGateway(page, {
      sessionKey,
      sessions: [session],
      authMethod: "trusted-proxy",
      authMode: "trusted-proxy",
      deferredMethods: ["connect"],
      historyMessages: [
        ...Array.from({ length: 60 }, (_, index) =>
          chatMessage(index % 2 ? "assistant" : "user", `Earlier checkpoint ${index}`, {
            __openclaw: { id: `earlier-${index}`, seq: index + 1 },
          }),
        ),
        chatMessage("user", "Give me the complete final answer.", {
          __openclaw: { id: "final-question", seq: 61 },
        }),
        chatMessage("assistant", "Synthetic final paragraph.\n\n".repeat(60), {
          __openclaw: { id: "final-answer", seq: 62 },
        }),
      ],
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await gateway.waitForRequest("connect");
    await gateway.resolveDeferred("connect");
    await page.locator('.chat-bubble[data-entry-id="final-answer"]').waitFor();
    await page.waitForFunction(() => {
      const pane = document.querySelector(".chat-pane-cache__pane--active");
      const cache = pane && Reflect.get(pane, "state")?.chatMessagesBySession;
      return (
        cache &&
        [...cache.values()].some(({ snapshot }) =>
          Object.keys(snapshot.widgetHeights ?? {}).some((key) => key.startsWith("row:v1:")),
        )
      );
    });
    await page.evaluate(async () => {
      await Reflect.get(
        document.querySelector(".chat-pane-cache__pane--active")!,
        "sessionSnapshotStore",
      ).flush();
    });
    await page.addInitScript(() => {
      const frames: unknown[] = [];
      Reflect.set(window, "railRestoreFrames", frames);
      const toggles: string[] = [];
      Reflect.set(window, "railRestoreToggles", toggles);
      const sample = () => {
        const rail = document.querySelector(".chat-position-rail");
        const inner = rail?.closest(".chat-thread")?.querySelector(".chat-thread-inner");
        if (rail && inner?.checkVisibility({ checkOpacity: true, visibilityProperty: true })) {
          const ids = (selector: string) =>
            [...rail.querySelectorAll<HTMLElement>(selector)].map(
              (marker) => marker.dataset.positionMarkerId,
            );
          if (!frames.length) {
            new MutationObserver((records) => {
              for (const record of records) {
                if (
                  record.oldValue === null ||
                  !(record.target as Element).hasAttribute("data-visible")
                ) {
                  toggles.push((record.target as HTMLElement).dataset.positionMarkerId!);
                }
              }
            }).observe(rail, {
              subtree: true,
              attributes: true,
              attributeFilter: ["data-visible"],
              attributeOldValue: true,
            });
          }
          frames.push({
            overflow: rail.hasAttribute("data-overflow"),
            visible: ids("[data-position-marker-id][data-visible]"),
            active: ids('[data-position-marker-id][aria-current="true"]'),
            opacity: getComputedStyle(rail).opacity,
            transitioning: rail
              .getAnimations({ subtree: true })
              .some((animation) => animation.playState === "running"),
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.reload();
    await gateway.waitForRequest("connect");
    await page.waitForFunction(() => Reflect.get(window, "railRestoreFrames").length >= 2);
    await page.locator('.chat-bubble[data-entry-id="final-answer"]').evaluate(async (bubble) => {
      await new Promise<void>((resolve) => {
        const observer = new IntersectionObserver(
          () => {
            observer.disconnect();
            requestAnimationFrame(() => resolve());
          },
          { root: bubble.closest(".chat-thread") },
        );
        observer.observe(bubble);
      });
    });
    const frames = await page.evaluate(() => Reflect.get(window, "railRestoreFrames") as unknown[]);
    expect(await page.evaluate(() => Reflect.get(window, "railRestoreToggles"))).toEqual([]);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames).toEqual(
      frames.map(() => ({
        overflow: true,
        visible: ["final-answer"],
        active: ["final-answer"],
        opacity: "1",
        transitioning: false,
      })),
    );
  });

  it("shows the position rail only when the conversation overflows", async () => {
    const page = await newChatPage(suite, {
      colorScheme: "dark",
      viewport: { width: 1440, height: 900 },
    });
    const answerText = "Short conversations need no navigation.";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        chatMessage("user", "Keep short chats distraction-free?", {
          __openclaw: { id: "short-question", seq: 1 },
        }),
        chatMessage("assistant", answerText, { __openclaw: { id: "short-answer", seq: 2 } }),
      ],
    });
    await page.addInitScript(createControlUiMockSameOriginGatewayScript());
    await page.goto(suite.server.baseUrl + "chat");
    const thread = page.locator(".chat-thread");
    const answer = page.getByText(answerText, { exact: true });
    await answer.waitFor();
    await waitForChatScrollIdle(page);
    expect(await thread.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
    await takeControlUiScreenshotFrame(page, thread, [answer], { animations: "disabled" });
    const marks = page.locator(".chat-position-rail__marks");
    expect(await marks.isVisible()).toBe(false);
    const marker = marks.locator("button").first();
    await marker.evaluate((element) => (element as HTMLElement).focus());
    expect(await marker.evaluate((element) => element === document.activeElement)).toBe(false);
    const rail = page.locator(".chat-position-rail");
    const duration = () => rail.evaluate((el) => getComputedStyle(el).transitionDuration);
    await rail.evaluate((element) => {
      element.addEventListener(
        "transitionrun",
        () => {
          const fade = element
            .getAnimations()
            .find(
              (animation) =>
                animation instanceof CSSTransition && animation.transitionProperty === "opacity",
            );
          if (fade) {
            const currentTime = fade.currentTime;
            fade.currentTime = 120;
            element.setAttribute("data-proof-fade-midpoint", getComputedStyle(element).opacity);
            fade.currentTime = currentTime;
          }
        },
        { once: true },
      );
    });
    const column = thread.locator(".chat-thread-inner");
    const columnLeft = await column.evaluate((element) => element.getBoundingClientRect().left);
    await page
      .locator(".agent-chat__composer-combobox textarea")
      .fill("Walk me through the details.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const request = await gateway.waitForRequest("chat.send");
    const runId = (request.params as { idempotencyKey: string }).idempotencyKey;
    await gateway.emitGatewayEvent("chat", {
      runId,
      sessionKey: "agent:main:main",
      state: "delta",
      message: chatMessage(
        "assistant",
        Array.from(
          { length: 12 },
          (_, index) =>
            `### Checkpoint ${index + 1}\nKeep the conversation easy to read while preserving useful navigation for longer discussions.`,
        ).join("\n\n"),
      ),
    });
    await expect
      .poll(() => thread.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(0);
    await marks.waitFor({ state: "visible" });
    await expect
      .poll(() => rail.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    expect(await duration()).toBe("0.24s");
    const midpoint = Number(await rail.getAttribute("data-proof-fade-midpoint"));
    expect(midpoint).toBeGreaterThan(0);
    expect(midpoint).toBeLessThan(1);
    expect(await column.evaluate((element) => element.getBoundingClientRect().left)).toBe(
      columnLeft,
    );
    await takeControlUiScreenshotFrame(page, thread, [marks], { animations: "disabled" });
    await marker.focus();
    await page.setViewportSize({ width: 1440, height: 3000 });
    await expect.poll(() => marks.isVisible()).toBe(false);
    expect(await thread.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await marks.waitFor({ state: "visible" });
    expect(await duration()).toBe("0s");
    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(() => marks.isVisible()).toBe(false);
  });
});
