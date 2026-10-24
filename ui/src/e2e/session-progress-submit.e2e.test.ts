import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { progressSubmitScenario } from "./session-progress-submit.test-support.ts";

const suite = createChatFlowE2eSuite();

function observeDetailsSubmit(page: Page, expectCard: boolean) {
  return page
    .locator(".agent-chat__composer-combobox textarea")
    .evaluateHandle((textarea, cardExpected) => {
      const pane = textarea.closest("openclaw-chat-pane")!;
      const cardSelector =
        '[data-progress-card-placement="details"], .task-progress-details--mobile';
      const card = pane.querySelector<HTMLElement>(cardSelector);
      if (Boolean(card) !== cardExpected) {
        throw new Error("Progress content must match the opened state before editing.");
      }
      const details = pane.querySelector<HTMLElement>(".chat-details")!;
      const composer = pane.querySelector<HTMLElement>(".agent-chat__input")!;
      let stopped = false;
      const sample = (source: string) => {
        const current = pane.querySelector<HTMLElement>(cardSelector);
        const bounds = current?.getBoundingClientRect();
        const input = composer.getBoundingClientRect();
        const panel = details.getBoundingClientRect();
        const session = pane.querySelector(".chat-details-session")?.getBoundingClientRect();
        const outputs = pane.querySelector('[data-details-group="outputs"]');
        return {
          source,
          height: bounds?.height ?? 0,
          top: bounds?.top ?? 0,
          open: current instanceof HTMLDetailsElement ? current.open : null,
          reveal: current?.dataset.reveal ?? null,
          retained: current === card && (!card || card.isConnected) && details.isConnected,
          detailsOpen: panel.height > 0,
          detailsTop: panel.top,
          detailsHeight: panel.height,
          detailsScroll: pane.querySelector(".chat-details-desktop-body")?.scrollTop ?? 0,
          precedingBottom: session?.bottom ?? 0,
          outputsHeight: outputs?.getBoundingClientRect().height ?? 0,
          outputsPending: outputs?.textContent?.includes("Updating outputs…") ?? false,
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
          if (card) {
            resize.observe(card);
          }
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
    }, expectCard);
}

suite.define(() => {
  it.each([
    { name: "collapsed desktop", mobile: false, expanded: false, multiline: false },
    { name: "Details-closed desktop", mobile: false, expanded: false, multiline: false },
    { name: "expanded desktop", mobile: false, expanded: true, multiline: false },
    { name: "multiline desktop", mobile: false, expanded: false, multiline: true },
    { name: "Details-closed mobile", mobile: true, expanded: false, multiline: false },
    { name: "retained mobile page", mobile: true, expanded: true, multiline: false },
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
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect(await page.locator(".chat-details:visible").count()).toBe(0);
        expect(await card.count()).toBe(0);
        expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
        const opened = !name.startsWith("Details-closed") && name !== "active run default mode";
        const detailsOpen = opened && !mobile;
        if (opened) {
          await openChatTaskProgress(page);
          if (!mobile && !expanded) {
            await card.locator("summary").click();
          }
        }
        await waitForChatScrollIdle(page);
        if (mobile) {
          await captureUiProof(suite, page, "mobile-progress", "initial.png");
        }
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        const observation = await observeDetailsSubmit(page, opened);
        await textarea.fill(
          multiline
            ? "Please continue.\nCheck the changes.\nShare the result."
            : "Please continue the review.",
        );
        await waitForChatScrollIdle(page);
        if (mobile) {
          // Editing parks the retained sheet without losing its selected page.
          await page.locator(".chat-mobile-host:visible").waitFor({ state: "hidden" });
        }
        if (detailsOpen) {
          await page.locator('[data-details-group="outputs"]').waitFor({ state: "detached" });
        }
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
        if (detailsOpen) {
          await page.locator('[data-details-group="outputs"]').waitFor({ state: "detached" });
        }
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
        expect(
          samples.every(
            (sample) =>
              Math.abs(sample.detailsTop - initial.detailsTop) <= 1 &&
              Math.abs(sample.detailsHeight - initial.detailsHeight - sample.outputsHeight) <= 1 &&
              sample.detailsScroll === initial.detailsScroll,
          ),
        ).toBe(true);
        if (detailsOpen) {
          // Outputs briefly occupies the preceding section while its empty result refreshes.
          // That sibling may move the in-flow card; the card's gap and outer panel must stay fixed.
          const gap = initial.top - initial.precedingBottom;
          expect(initial.outputsHeight).toBe(0);
          expect(
            samples.every(
              (sample) =>
                Math.abs(sample.top - sample.precedingBottom - gap) <= 1 &&
                Math.abs(sample.top - initial.top - sample.outputsHeight) <= 1 &&
                sample.outputsHeight > 0 === sample.outputsPending,
            ),
          ).toBe(true);
          expect(samples.at(-1)!.outputsHeight).toBe(0);
          expect(samples.at(-1)!.top).toBeCloseTo(initial.top, 0);
          expect(samples.at(-1)!.detailsHeight).toBeCloseTo(initial.detailsHeight, 0);
        } else {
          expect(samples.every((sample) => Math.abs(sample.top - initial.top) <= 1)).toBe(true);
        }
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
        expect(initial.open).toBe(detailsOpen ? expanded : null);
        expect(initial.detailsOpen).toBe(detailsOpen);
        if (mobile) {
          await captureUiProof(suite, page, "mobile-progress", "after-send.png");
        }
        expect(await textarea.inputValue()).toBe("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        if (
          name === "collapsed desktop" ||
          name === "Details-closed desktop" ||
          name === "retained mobile page"
        ) {
          const progress = await openChatTaskProgress(page);
          const plan = progress.locator(".task-progress-details__plan");
          await plan.waitFor({ state: "attached" });
          await gateway.setMethodResponse("progressCard.get", { card: null });
          await gateway.emitGatewayEvent("progressCard.changed", {
            sessionKey: scenario.sessionKey,
            revision: null,
          });
          if (mobile) {
            await progress.getByText("No saved progress", { exact: true }).waitFor();
          } else {
            await card.waitFor({ state: "detached" });
          }
          await gateway.setMethodResponse("progressCard.get", {
            card: { ...scenario.methodResponses["progressCard.get"].card, revision: 4 },
          });
          await gateway.emitGatewayEvent("progressCard.changed", {
            sessionKey: scenario.sessionKey,
            revision: 4,
          });
          await plan.waitFor({ state: "attached" });
          if (!mobile) {
            expect(await card.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
              true,
            );
          }
          expect(await progress.isVisible()).toBe(true);
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
