import { webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { expect, it, vi } from "vitest";
import { installMockGateway, navigateToControlUiSession } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  countDetachedWebKitShimmers,
  readWebKitAnimations,
} from "../test-helpers/control-ui-webkit-animations.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

let browser: Browser;
const suite = createControlUiE2eSuite({
  name: "Control UI loading animation retirement",
  resources: {
    async run() {
      browser = await webkit.launch({ headless: true });
    },
    async close() {
      await browser?.close();
    },
  },
});

suite.define(() => {
  it("omits retired Inspector IDs while retaining live detached animations", async () => {
    const context = await browser.newContext(createControlUiE2eContextOptions());
    try {
      const page = await context.newPage();
      await page.setContent(`
        <style>
          @keyframes shimmer { from { opacity: .2 } to { opacity: .8 } }
          @keyframes other { from { opacity: .3 } to { opacity: .7 } }
          #shimmer { animation: shimmer 1s infinite; }
          #other { animation: other 1s infinite; }
        </style>
        <div id="shimmer"></div><div id="other"></div>
      `);
      const retained = await page.evaluate(async () => {
        const animation = document.querySelector("#shimmer")!.getAnimations()[0]!;
        const target = document.createElement("div");
        target.className = "retained-detached";
        animation.effect = new KeyframeEffect(target, [{ opacity: 0.2 }, { opacity: 0.8 }], {
          duration: 1000,
          iterations: Infinity,
        });
        animation.play();
        Reflect.set(window, "retainedAnimation", animation);
        await animation.ready;
        return {
          type: animation.constructor.name,
          name: animation instanceof CSSAnimation ? animation.animationName : null,
          connected: target.isConnected,
          playState: animation.playState,
        };
      });
      expect(retained).toEqual({
        type: "CSSAnimation",
        name: "shimmer",
        connected: false,
        playState: "running",
      });
      await page.evaluate(() => {
        // An idle animation has no pending playback activity retaining its wrapper.
        const animation = new Animation(null, document.timeline);
        animation.id = "retire-before-resolution";
        Reflect.set(window, "retiringAnimation", animation);
      });
      type Created = { animation: { animationId: string; name?: string } };
      type InspectorSession = {
        send(method: string, params?: Record<string, unknown>): Promise<unknown>;
        on(event: "Animation.animationCreated", listener: (event: Created) => void): void;
        on(
          event: "Animation.animationDestroyed",
          listener: (event: { animationId: string }) => void,
        ): void;
        off(event: "Animation.animationCreated", listener: (event: Created) => void): void;
        off(
          event: "Animation.animationDestroyed",
          listener: (event: { animationId: string }) => void,
        ): void;
      };
      type WebKitPage = {
        _connection: { toImpl(page: Page): { delegate: { _session: InspectorSession } } };
      };
      // eslint-disable-next-line no-underscore-dangle -- observe the helper's pinned native Inspector connection without a second client.
      const session = (page as Page & WebKitPage)._connection.toImpl(page).delegate._session;
      let retiringId: string | undefined;
      let retiredError: unknown;
      let retirementBarriers = 0;
      let retirementEvents = 0;
      const retirement = Promise.withResolvers<void>();
      const destroyed = ({ animationId }: { animationId: string }) => {
        if (animationId === retiringId) {
          retirementEvents++;
          retirement.resolve();
        }
      };
      const created = ({ animation }: Created) => {
        if (animation.name === "retire-before-resolution") {
          retiringId = animation.animationId;
        }
      };
      session.on("Animation.animationCreated", created);
      session.on("Animation.animationDestroyed", destroyed);
      const send = session.send.bind(session);
      const spy = vi.spyOn(session, "send").mockImplementation(async (method, params) => {
        if (method === "Animation.resolveAnimation" && params?.animationId === retiringId) {
          retirementBarriers++;
          await page.evaluate(() => {
            const animation: unknown = Reflect.get(window, "retiringAnimation");
            if (!(animation instanceof Animation)) {
              throw new Error("Owned transient animation is missing");
            }
            animation.cancel();
            Reflect.deleteProperty(window, "retiringAnimation");
          });
          // Collect the owned transient once, then observe its native retirement.
          await send("Heap.gc");
          await retirement.promise;
          try {
            return await send(method, params);
          } catch (error) {
            retiredError = error;
            throw error;
          }
        }
        return send(method, params);
      });
      try {
        const animations = await readWebKitAnimations(page);
        expect(retiringId).toBeTypeOf("string");
        expect(retiredError).toBeInstanceOf(Error);
        expect(retiredError).toMatchObject({
          message:
            "Protocol error (Animation.resolveAnimation): Missing animation for given animationId",
        });
        expect(animations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "shimmer",
              connected: false,
              playState: "running",
              target: "DIV.retained-detached",
            }),
            expect.objectContaining({ name: "other", connected: true, playState: "running" }),
          ]),
        );
        expect(await countDetachedWebKitShimmers(page)).toEqual({ detached: 1, running: 1 });
        expect(retirementBarriers).toBe(1);
        expect(retirementEvents).toBe(1);
      } finally {
        spy.mockRestore();
        session.off("Animation.animationCreated", created);
        session.off("Animation.animationDestroyed", destroyed);
      }
    } finally {
      await context.close();
    }
  });

  it("retires bootstrap and session-loading shimmers as sessions are replaced", async () => {
    const sessions = Array.from({ length: 20 }, (_, index) =>
      createControlUiSessionRow(`agent:main:animation-${index}`, `Session ${index}`, index),
    );
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const context = await browser.newContext({
          ...createControlUiE2eContextOptions(),
          reducedMotion: "no-preference",
        });
        contexts.push(context);
        const page = await context.newPage();
        pages.push(page);
        await installMockGateway(page, { sessions, sessionKey: sessions[0]!.key });
        await page.goto(suite.server.baseUrl + "new");
      }
      for (const [index, page] of pages.entries()) {
        // Match the final three retained panes without aging the control.
        for (const session of index === 0 ? sessions : sessions.slice(-3)) {
          await navigateToControlUiSession(page, session.key);
          const pane = page.locator(".chat-pane-cache__pane--active");
          await expect
            .poll(() => pane.evaluate((node) => Reflect.get(node, "sessionKey")))
            .toBe(session.key);
          await expect
            .poll(() => pane.evaluate((node) => Reflect.get(node, "transcriptReady")))
            .toBe(true);
          await pane.locator("textarea").waitFor();
        }
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
      }
      // Inspect only after churn: connected getAnimations() forces style and
      // changes the short-lived fallback lifecycle that exposed this bug.
      const aged = await countDetachedWebKitShimmers(pages[0]!);
      const fresh = await countDetachedWebKitShimmers(pages[1]!);
      // Static bootstrap placeholders must not leave effects behind either.
      expect(fresh).toEqual({ detached: 0, running: 0 });
      expect(aged).toEqual({ detached: 0, running: 0 });
    } finally {
      for (const context of contexts) {
        await context.close();
      }
    }
  });
});
