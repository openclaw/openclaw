import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  chatMessage,
  newChatPage,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const visiblePane = ".chat-pane-cache__pane--visible";
const skeletonSelector = `${visiblePane} .chat-thread :is(openclaw-panel-loading-skeleton, .lazy-view-state--loading)`;
const textInThread = (page: Page, text: string, root = ".chat-thread") =>
  page.locator(root).getByText(text);
const sessionLink = (page: Page, session: string) =>
  page.locator(`[data-session-key="agent:main:session-${session}"] a.sidebar-recent-session__link`);

suite.define(() => {
  it("switches immediately but shows a skeleton only for slow history", async () => {
    const page = await newChatPage(suite, {
      ...createControlUiE2eContextOptions(),
      reducedMotion: "no-preference",
    });
    const previousText = "Previous conversation.";
    const destinationText = "Destination conversation.";
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup", "chat.history"],
      sessionKey: "agent:main:session-a",
      historyMessages: [{ role: "assistant", content: previousText }],
      sessionTranscripts: {
        "agent:main:session-b": {
          messages: [{ role: "assistant", content: destinationText }],
        },
      },
      methodResponses: { "sessions.list": chatSessionListResponse() },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
    await gateway.waitForRequest("chat.startup");
    const loader = page.locator(skeletonSelector);
    await loader.waitFor({ state: "attached" });
    const frames = await loader.evaluate(async (node) => {
      // Restart the CSS animation for clock samples even if CI reached this node after completion.
      node.style.animationName = "none";
      void getComputedStyle(node).animationName;
      node.style.animationName = "";
      const animation = node
        .getAnimations()
        .find(
          (entry) =>
            entry instanceof CSSAnimation && entry.animationName === "chat-skeleton-reveal",
        );
      if (!animation) {
        throw new Error("The loading skeleton has no reveal animation");
      }
      await animation.ready;
      animation.pause();
      return [499, 575, 650].map((time) => {
        animation.currentTime = time;
        const style = getComputedStyle(node);
        return { opacity: Number(style.opacity), visibility: style.visibility };
      });
    });
    expect(frames[0]).toEqual({ opacity: 0, visibility: "hidden" });
    expect(frames[1]?.opacity).toBeGreaterThan(0);
    expect(frames[1]?.opacity).toBeLessThan(1);
    expect(frames[2]).toEqual({ opacity: 1, visibility: "visible" });
    await gateway.resolveDeferred("chat.startup");
    const previous = textInThread(page, previousText);
    await previous.waitFor({ state: "visible" });
    expect(await loader.count()).toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    await gateway.deferNext("chat.startup");
    const [revealDelay] = await Promise.all([
      page.evaluate(
        async ({ selector, oldText }) => {
          const started = performance.now();
          let animation: Animation | undefined;
          let previousVisible = false;
          const capture = () => {
            animation ??= document
              .querySelector(selector)
              ?.getAnimations()
              .find(
                (entry) =>
                  entry instanceof CSSAnimation && entry.animationName === "chat-skeleton-reveal",
              );
          };
          // Retain the reduced-motion clock before its finished effect disappears.
          const observer = new MutationObserver(capture);
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
          });
          try {
            while (performance.now() - started <= 3_000) {
              const skeleton = document.querySelector(selector);
              if (skeleton) {
                capture();
                previousVisible ||= [...document.querySelectorAll("openclaw-chat-pane")].some(
                  (pane) =>
                    getComputedStyle(pane).opacity !== "0" &&
                    pane.getAttribute("aria-hidden") === "false" &&
                    pane.textContent.includes(oldText),
                );
                if (
                  getComputedStyle(skeleton).visibility === "visible" &&
                  typeof animation?.currentTime === "number"
                ) {
                  return { delay: animation.currentTime, previousVisible };
                }
              }
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
              });
            }
            return { delay: -1, previousVisible };
          } finally {
            observer.disconnect();
          }
        },
        { selector: skeletonSelector, oldText: previousText },
      ),
      sessionLink(page, "b").click(),
    ]);
    expect(revealDelay.delay).toBeGreaterThanOrEqual(480);
    expect(revealDelay.previousVisible).toBe(false);
    expect(revealDelay.delay).toBeLessThan(1_000);
    await expect
      .poll(() =>
        loader.evaluate((node) => ({
          opacity: getComputedStyle(node).opacity,
          duration: getComputedStyle(node).animationDuration,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        })),
      )
      .toEqual({ opacity: "1", duration: "1e-05s", reduced: true });
    expect(await textInThread(page, previousText, visiblePane).count()).toBe(0);
    await gateway.resolveDeferred("chat.startup");
    await textInThread(page, destinationText).waitFor({ state: "visible" });
    await sessionLink(page, "a").click();
    await previous.waitFor({ state: "visible" });
    expect(await page.locator(`${visiblePane} openclaw-panel-loading-skeleton`).count()).toBe(0);
  });

  it.each(["named", "short"] as const)(
    "retains deferred history across %s chat canonicalization",
    async (reference) => {
      const page = await newChatPage(suite);
      const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
      const marker = "The selected conversation survived canonical navigation.";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        historyMessages: [{ role: "assistant", content: "Initial conversation." }],
        sessionTranscripts: {
          [sessionKey]: { messages: [{ role: "assistant", content: marker }] },
        },
        methodResponses: {
          "sessions.list": chatSessionListResponse([
            {
              key: sessionKey,
              kind: "direct",
              label: "Canonical history",
              displayName: "Canonical history",
              updatedAt: 1,
            },
          ]),
          "sessions.resolve": {
            ok: true,
            key: sessionKey,
            agentId: "main",
            displayName: "Canonical history",
          },
        },
      });
      const referencePath = `chat/main/${reference === "named" ? "canonical-history" : "old-name-12345678"}`;
      const canonicalId = reference === "named" ? "1234567890abcdef1234567890abcdef" : "12345678";
      const canonicalPath = new URL(
        `chat/main/canonical-history-${canonicalId}`,
        suite.server.baseUrl,
      ).pathname;
      await page.goto(`${suite.server.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
      await textInThread(page, "Initial conversation.").waitFor({ state: "visible" });
      const initialStartups = (await gateway.getRequests("chat.startup")).length;
      await gateway.deferNext("chat.startup");
      await evaluateControlUiContext(
        page,
        (application, pathname) => {
          application.navigate("chat", { pathname });
        },
        new URL(referencePath, suite.server.baseUrl).pathname,
      );
      await gateway.waitForRequest("chat.startup", { after: initialStartups });
      if (reference === "named") {
        await page.waitForURL((url) => url.pathname === canonicalPath, {
          waitUntil: "domcontentloaded",
        });
        expect(await gateway.getRequests("chat.startup")).toHaveLength(initialStartups + 1);
      }
      await gateway.resolveDeferred("chat.startup");
      await page.waitForURL((url) => url.pathname === canonicalPath, {
        waitUntil: "domcontentloaded",
      });
      await textInThread(page, marker, ".chat-pane-cache__pane--active .chat-thread").waitFor({
        state: "visible",
      });
      await page.waitForFunction(
        (key) =>
          [...document.querySelectorAll<HTMLElement>("openclaw-chat-pane")].some(
            (pane) =>
              pane.classList.contains("chat-pane-cache__pane--visible") &&
              (pane as HTMLElement & { sessionKey?: string }).sessionKey === key,
          ),
        sessionKey,
      );
      expect(await gateway.getRequests("chat.startup")).toHaveLength(initialStartups + 1);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(1);
    },
  );

  it("keeps cached history visible through a failed refresh and manual retry", async () => {
    const page = await newChatPage(suite);
    const marker = "Retained transcript";
    const failure = "History refresh failed.";
    const gateway = await installMockGateway(page, {
      historyMessages: [chatMessage("assistant", marker, { timestamp: Date.now() })],
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const transcript = textInThread(page, marker);
    await transcript.waitFor({ state: "visible" });
    await gateway.deferNext("chat.startup");
    await gateway.setOnline(false);
    await gateway.setOnline(true);
    await gateway.waitForRequest("chat.startup", { after: 1 });
    await gateway.rejectDeferred("chat.startup", {
      code: "GATEWAY_ERROR",
      message: failure,
      retryable: false,
    });
    const error = page.locator(".chat-history-error--inline");
    await error.waitFor({ state: "visible", timeout: 5_000 });
    expect(await error.textContent()).toContain(failure);
    await transcript.waitFor({ state: "visible" });
    const before = (await gateway.getRequests("chat.startup")).length;
    await error.getByRole("button", { name: "Retry" }).click();
    await gateway.waitForRequest("chat.startup", { after: before });
    await error.waitFor({ state: "hidden", timeout: 5_000 });
    await transcript.waitFor({ state: "visible" });
  });
});
