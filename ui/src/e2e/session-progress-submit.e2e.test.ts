import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { progressSubmitScenario } from "./session-progress-submit.test-support.ts";

const suite = createChatFlowE2eSuite();

function observeDetailsSubmit(page: Page) {
  return page.locator(".agent-chat__composer-combobox textarea").evaluateHandle((textarea) => {
    const pane = textarea.closest("openclaw-chat-pane")!;
    const card = pane.querySelector<HTMLDetailsElement>(
      '[data-progress-card-placement="details"]',
    )!;
    const details = pane.querySelector<HTMLElement>(".chat-details")!;
    const composer = pane.querySelector<HTMLElement>(".agent-chat__input")!;
    let stopped = false;
    const sample = (source: string) => {
      const current = pane.querySelector<HTMLDetailsElement>(
        '[data-progress-card-placement="details"]',
      );
      const bounds = current?.getBoundingClientRect();
      const input = composer.getBoundingClientRect();
      return {
        source,
        height: bounds?.height ?? 0,
        top: bounds?.top ?? 0,
        open: current?.open ?? null,
        reveal: current?.dataset.reveal ?? null,
        retained: current === card && card.isConnected && details.isConnected,
        detailsOpen: details.matches(":popover-open"),
        composerHeight: input.height,
        composerTop: input.top,
        queueRows: pane.querySelectorAll(".chat-queue__item").length,
      };
    };
    const samples: ReturnType<typeof sample>[] = [];
    const mutations = new MutationObserver(() => samples.push(sample("mutation")));
    const resize = new ResizeObserver(() => samples.push(sample("resize")));
    textarea.addEventListener(
      "keydown",
      function start(event) {
        if ((event as KeyboardEvent).key !== "Enter") {
          return;
        }
        textarea.removeEventListener("keydown", start, true);
        samples.push(sample("keydown"));
        mutations.observe(details, { attributes: true, childList: true, subtree: true });
        mutations.observe(pane.querySelector(".agent-chat__composer-shell")!, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        resize.observe(card);
        resize.observe(composer);
        const frame = () => {
          if (!stopped) {
            samples.push(sample("frame"));
            requestAnimationFrame(frame);
          }
        };
        requestAnimationFrame(frame);
      },
      { capture: true },
    );
    return {
      async finish() {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        stopped = true;
        mutations.disconnect();
        resize.disconnect();
        return samples;
      },
    };
  });
}

suite.define(() => {
  it.each([
    { name: "collapsed desktop", mobile: false, expanded: false, multiline: false },
    { name: "Details-closed desktop", mobile: false, expanded: false, multiline: false },
    { name: "expanded desktop", mobile: false, expanded: true, multiline: false },
    { name: "multiline desktop", mobile: false, expanded: false, multiline: true },
    { name: "collapsed mobile", mobile: true, expanded: false, multiline: false },
    { name: "expanded mobile", mobile: true, expanded: true, multiline: false },
    { name: "active run default mode", mobile: false, expanded: false, multiline: false },
  ])(
    "keeps task progress steady through Enter, streaming, and refresh: $name",
    async ({ name, mobile, expanded, multiline }) => {
      const context = await suite.newBrowserContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      try {
        const scenario = progressSubmitScenario(name === "active run default mode");
        const gateway = await installMockGateway(page, scenario);
        await page.goto(`${suite.server.baseUrl}chat`);
        const card = page.locator('[data-progress-card-placement="details"]');
        await card.waitFor({ state: "attached" });
        expect(await page.locator(".chat-details:popover-open").count()).toBe(0);
        expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
        const detailsOpen = name !== "Details-closed desktop" && name !== "active run default mode";
        if (detailsOpen) {
          await openChatDetails(page);
          if (!expanded) {
            await card.locator("summary").click();
          }
        }
        await waitForChatScrollIdle(page);
        if (mobile) {
          await captureUiProof(suite, page, "mobile-progress", "initial.png");
        }
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        await textarea.fill(
          multiline
            ? "Please continue.\nCheck the changes.\nShare the result."
            : "Please continue the review.",
        );
        await waitForChatScrollIdle(page);
        const observation = await observeDetailsSubmit(page);
        await textarea.press("Enter");
        const request = await gateway.waitForRequest("chat.send");
        const runId = (request.params as { idempotencyKey: string }).idempotencyKey;
        await gateway.resolveDeferred("chat.send", { runId, status: "started" });
        await gateway.emitGatewayEvent("chat", {
          sessionKey: scenario.sessionKey,
          runId,
          state: "delta",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Checking the workspace." }],
          },
        });
        await gateway.setMethodResponse("progressCard.get", {
          card: { ...scenario.methodResponses["progressCard.get"].card, revision: 2 },
        });
        await gateway.emitGatewayEvent("progressCard.changed", {
          sessionKey: scenario.sessionKey,
          revision: 2,
        });
        await gateway.emitChatFinal({ runId, text: "The review is complete." });
        await page
          .locator(".chat-bubble")
          .getByText("The review is complete.", { exact: true })
          .waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("progressCard.get")).length)
          .toBeGreaterThan(1);
        const samples = await observation.evaluate((probe) => probe.finish());
        await observation.dispose();
        await writeFile(
          path.join(suite.artifactDir, `${name.replaceAll(" ", "-")}.json`),
          JSON.stringify(samples),
        );
        if (name === "Details-closed desktop") {
          await captureUiProof(suite, page, "Details-closed", "after-send.png");
        }
        const initial = samples[0]!;
        expect(samples.filter((sample) => sample.source === "frame").length).toBeGreaterThan(1);
        expect(
          samples.every(
            (sample) =>
              sample.retained &&
              sample.open === initial.open &&
              sample.reveal === initial.reveal &&
              sample.detailsOpen === detailsOpen,
          ),
        ).toBe(true);
        expect(samples.every((sample) => Math.abs(sample.height - initial.height) <= 1)).toBe(true);
        expect(samples.every((sample) => sample.queueRows === 0)).toBe(true);
        // Details is out of flow: card geometry must not move with the composer.
        expect(samples.every((sample) => Math.abs(sample.top - initial.top) <= 1)).toBe(true);
        if (!multiline) {
          expect(
            samples.every((sample) => Math.abs(sample.composerTop - initial.composerTop) <= 1),
          ).toBe(true);
          expect(
            samples.every(
              (sample) => Math.abs(sample.composerHeight - initial.composerHeight) <= 1,
            ),
          ).toBe(true);
        }
        expect(initial.open).toBe(detailsOpen ? expanded : true);
        expect(initial.detailsOpen).toBe(detailsOpen);
        if (mobile) {
          await captureUiProof(suite, page, "mobile-progress", "after-send.png");
        }
        expect(await textarea.inputValue()).toBe("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        if (
          name === "collapsed desktop" ||
          name === "Details-closed desktop" ||
          name === "expanded mobile"
        ) {
          await gateway.setMethodResponse("progressCard.get", { card: null });
          await gateway.emitGatewayEvent("progressCard.changed", {
            sessionKey: scenario.sessionKey,
            revision: null,
          });
          await card.waitFor({ state: "detached" });
          await gateway.setMethodResponse("progressCard.get", {
            card: { ...scenario.methodResponses["progressCard.get"].card, revision: 4 },
          });
          await gateway.emitGatewayEvent("progressCard.changed", {
            sessionKey: scenario.sessionKey,
            revision: 4,
          });
          await card.waitFor({ state: "attached" });
          expect(await page.locator(".chat-details:popover-open").count()).toBe(
            detailsOpen ? 1 : 0,
          );
          await openChatDetails(page);
          await card.waitFor();
          expect(await card.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
