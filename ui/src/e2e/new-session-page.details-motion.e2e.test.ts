import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { timedText } from "./chat-flow-fixtures.test-support.ts";
import { nextPaint } from "./chat-session-diff.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eContextOptions,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);

suite.define(() => {
  it("keeps the first message visible and grows compact Details as content arrives", async () => {
    const page = await openPage({
      ...createControlUiE2eContextOptions(),
      viewport: { width: 1700, height: 960 },
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const module = await holdModuleResponse(
      page,
      controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-details-session.tsx"),
    );
    onTestFinished(module.release);
    const key = "agent:main:details-first-load";
    const request = "Review the session layout";
    const gateway = await installMockGateway(page, {
      historyMessages: [],
      heldMethods: ["sessions.create"],
      methodResponses: { "sessions.create": { key, runStarted: true, runId: "first-load" } },
    });
    await page.goto(suite.server.baseUrl + "new");
    const composer = page.locator(".new-session-page__message");
    await composer.fill(request);
    const preview = await holdModuleResponse(
      page,
      controlUiE2eBuiltModuleRequest("ui/src/pages/new-session/draft-submission-view.tsx"),
    );
    const followup = await holdModuleResponse(
      page,
      controlUiE2eBuiltModuleRequest("ui/src/pages/new-session/creation-composer-render.tsx"),
    );
    onTestFinished(() => {
      preview.release();
      followup.release();
    });
    const probe = await page.evaluateHandle(() => {
      const samples: Array<{ loaders: number; message: boolean; composer: boolean }> = [];
      let sawMessage = false;
      let active = true;
      const sample = () => {
        if (!active) {
          return;
        }
        const visible = (element: Element) => {
          const box = element.getBoundingClientRect();
          return (
            element.checkVisibility({ checkOpacity: true, visibilityProperty: true }) &&
            box.bottom > 0 &&
            box.top < innerHeight &&
            box.right > 0 &&
            box.left < innerWidth
          );
        };
        const message = [...document.querySelectorAll(".chat-bubble[data-message-text]")].some(
          visible,
        );
        sawMessage ||= message;
        if (sawMessage) {
          samples.push({
            loaders: [
              ...document.querySelectorAll(".loading-skeleton,.chat-conversation-loading"),
            ].filter(visible).length,
            message,
            composer: [
              ...document.querySelectorAll(".agent-chat__input,.creation-composer__loading"),
            ].some(visible),
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return {
        stop: () => {
          active = false;
          return samples;
        },
      };
    });
    await composer.press("Enter");
    await gateway.waitForRequest("sessions.create");
    await Promise.all([preview.request, followup.request]);
    await page.locator(".new-session-page__scroll .chat-bubble[data-message-text]").waitFor();
    expect(
      await page.locator(".new-session-page__scroll .chat-bubble[data-message-text]").textContent(),
    ).toContain(request);
    expect(await page.locator(".loading-skeleton").filter({ visible: true }).count()).toBe(0);
    preview.release();
    followup.release();
    await page.locator("openclaw-pending-session-create").waitFor();
    await gateway.resolveDeferred("sessions.create");
    await module.request;
    const details = page.locator(".chat-pane-cache__pane--active .chat-details[data-open]");
    const loading = details.getByRole("status", { name: "Loading…", exact: true });
    await loading.waitFor();
    const readSurface = () =>
      details.evaluate((panel) => {
        const { height, x, y } = panel.getBoundingClientRect();
        const { backgroundColor, borderTopColor, boxShadow } = getComputedStyle(panel);
        return { height, x, y, backgroundColor, borderTopColor, boxShadow };
      });
    await expect.poll(() => details.evaluate((panel) => panel.getAnimations().length)).toBe(0);
    const before = await readSurface();
    expect(before.height).toBe(48);
    expect(before.boxShadow).not.toBe("none");

    module.release();
    await details.locator("section.chat-details-session").waitFor({ state: "attached" });
    await nextPaint(page);
    await loading.waitFor();
    expect(await readSurface()).toEqual(before);

    const sessionId = await page.evaluate(
      () =>
        Reflect.get(document.querySelector(".chat-pane-cache__pane--active")!, "state")
          .currentSessionId,
    );
    expect(sessionId).toBeTruthy();
    const row = {
      key,
      sessionId,
      kind: "direct",
      updatedAt: Date.now(),
      worktree: {
        id: "first-load-worktree",
        branch: "demo/review-layout",
        repoRoot: "/workspace/demo",
      },
    };
    await gateway.emitGatewayEvent("sessions.changed", {
      ...row,
      session: row,
      reason: "patch",
      sessionKey: key,
    });
    await details.getByText("demo/review-layout", { exact: true }).waitFor();
    await expect
      .poll(() => details.evaluate((panel) => panel.getAnimations({ subtree: true }).length))
      .toBe(0);
    const loaded = await readSurface();
    expect(loaded.height).toBeGreaterThan(before.height);
    expect(loaded).toMatchObject({ x: before.x, y: before.y });
    expect(loaded.backgroundColor).toBe(before.backgroundColor);
    await loading.waitFor({ state: "hidden" });
    const samples = await probe.evaluate((value) => value.stop());
    await probe.dispose();
    expect(samples.length).toBeGreaterThan(2);
    expect(samples.every((frame) => frame.loaders === 0)).toBe(true);
    expect(samples.filter((frame) => !frame.message)).toEqual([]);
    expect(samples.filter((frame) => !frame.composer)).toEqual([]);
  });

  it.each([
    { label: "fresh reveal", reducedMotion: "no-preference", width: 1700, animate: true },
    { label: "reduced motion", reducedMotion: "reduce", width: 1700, animate: false },
    { label: "later resize", reducedMotion: "no-preference", width: 1100, animate: false },
  ] as const)(
    "reveals Details after session creation: $label",
    async ({ label, reducedMotion, width: initialWidth, animate }) => {
      const page = await openPage({
        ...createControlUiE2eContextOptions(),
        viewport: { width: initialWidth, height: 1000 },
        reducedMotion,
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1700, height: 1000 } } }
          : {}),
      });
      const gateway = await installMockGateway(page, {
        heldMethods: ["sessions.create"],
        historyMessages: [timedText("user", "Check the session layout")],
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").fill("Check the session layout");
      await page.locator(".new-session-page__message").press("Enter");
      await gateway.waitForRequest("sessions.create");
      await page.locator("openclaw-pending-session-create").waitFor();
      if (captureUiProofEnabled) {
        await page.screenshot({
          path: path.join(suite.artifactDir, reducedMotion + "-before.png"),
        });
      }
      if (initialWidth < 1700) {
        await gateway.resolveDeferred("sessions.create");
        await page.locator(".chat-details-toggle").waitFor();
      }
      const initialLeft = await page
        .locator(".chat-footer textarea")
        .evaluate((element) => element.getBoundingClientRect().left);
      const motion = await page.evaluateHandle(() => {
        const samples: number[] = [];
        const positions: number[] = [];
        const sample = (frame: Element | null) => {
          const width = frame
            ? Number.parseFloat(getComputedStyle(frame).getPropertyValue("--chat-details-space")) ||
              0
            : 0;
          samples.push(width);
          const composer = document.querySelector(".chat-footer textarea");
          if (composer) {
            positions.push(composer.getBoundingClientRect().left);
          }
          return width;
        };
        // CI can skip every middle frame. Sample the actual transition timeline
        // when it starts, then restore playback for the final geometry check.
        const captureTransition = (event: Event) => {
          if (
            !(event instanceof TransitionEvent) ||
            event.propertyName !== "--chat-details-space" ||
            !(event.target instanceof Element) ||
            !event.target.matches(".chat-main__conversation-frame")
          ) {
            return;
          }
          const animation = event.target
            .getAnimations()
            .find(
              (entry) =>
                entry instanceof CSSTransition && entry.transitionProperty === event.propertyName,
            );
          if (!animation?.effect) {
            return;
          }
          const currentTime = animation.currentTime;
          animation.pause();
          animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
          sample(event.target);
          animation.currentTime = currentTime;
          animation.play();
        };
        document.addEventListener("transitionrun", captureTransition);
        return {
          result: (async () => {
            const deadline = performance.now() + 5000;
            try {
              while (performance.now() < deadline) {
                await new Promise(requestAnimationFrame);
                if (sample(document.querySelector(".chat-main__conversation-frame")) >= 313) {
                  break;
                }
              }
            } finally {
              document.removeEventListener("transitionrun", captureTransition);
            }
            return { samples, positions };
          })(),
        };
      });
      if (initialWidth < 1700) {
        await page.setViewportSize({ width: 1700, height: 1000 });
      } else {
        await gateway.resolveDeferred("sessions.create");
      }
      const { samples, positions } = await motion.evaluate(({ result }) => result);
      await motion.dispose();
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(suite.artifactDir, reducedMotion + "-after.png") });
      }
      expect(samples.at(-1)).toBe(313);
      expect(
        samples.some((width) => width > 1 && width < 312),
        JSON.stringify(samples),
      ).toBe(animate);
      if (animate) {
        const finalLeft = positions.at(-1)!;
        expect(finalLeft).toBeLessThan(initialLeft);
        expect(positions.some((left) => left > finalLeft + 1 && left < initialLeft - 1)).toBe(true);
      }
      if (captureUiProofEnabled) {
        const video = page.video();
        await page.context().close();
        await video?.saveAs(path.join(suite.artifactDir, label.replaceAll(" ", "-") + ".webm"));
      }
    },
  );
});
