import type { Page } from "playwright";
import { expect, it } from "vitest";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatMessage,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { progressSubmitScenario } from "./session-progress-submit.test-support.ts";

const suite = createChatFlowE2eSuite();

function observeDetailsSubmit(page: Page) {
  return page.locator(".agent-chat__composer-combobox textarea").evaluateHandle((textarea) => {
    const pane = textarea.closest("openclaw-chat-pane")!;
    const getCard = () =>
      pane.querySelector<HTMLDetailsElement>('[data-progress-card-placement="details"]');
    const card = getCard()!;
    const details = pane.querySelector<HTMLElement>(".chat-details")!;
    const composer = pane.querySelector<HTMLElement>(".agent-chat__input")!;
    let frameId = 0;
    const sample = (source: string) => {
      const current = getCard();
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
    function start(event: Event) {
      if ((event as KeyboardEvent).key !== "Enter") {
        return;
      }
      textarea.removeEventListener("keydown", start, true);
      samples.push(sample("keydown"));
      for (const target of [details, pane.querySelector(".agent-chat__composer-shell")!]) {
        mutations.observe(target, { attributes: true, childList: true, subtree: true });
      }
      resize.observe(card);
      resize.observe(composer);
      const frame = () => {
        samples.push(sample("frame"));
        frameId = requestAnimationFrame(frame);
      };
      frameId = requestAnimationFrame(frame);
    }
    textarea.addEventListener("keydown", start, { capture: true });
    return {
      async finish() {
        await new Promise<number>(requestAnimationFrame);
        await new Promise<number>(requestAnimationFrame);
        cancelAnimationFrame(frameId);
        mutations.disconnect();
        resize.disconnect();
        return samples;
      },
    };
  });
}

suite.define(() => {
  it.each([
    ["collapsed desktop", false, false, false, true],
    ["Details-closed desktop", false, false, false, true],
    ["expanded desktop", false, true, false, false],
    ["multiline desktop", false, false, true, false],
    ["collapsed mobile", true, false, false, false],
    ["expanded mobile", true, true, false, true],
    ["active run default mode", false, false, false, false],
  ] as const)(
    "keeps task progress steady through Enter, streaming, and refresh: %s",
    async (name, mobile, expanded, multiline, reset) => {
      const contextOptions = {
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      };
      await suite.withPage(contextOptions, async ({ page }) => {
        const scenario = progressSubmitScenario(name === "active run default mode");
        const gateway = await installMockGateway(page, scenario);
        const updateProgress = async (revision: number | null) => {
          const baseline = scenario.methodResponses["progressCard.get"].card;
          await gateway.setMethodResponse("progressCard.get", {
            card: revision === null ? null : { ...baseline, revision },
          });
          await gateway.emitGatewayEvent("progressCard.changed", {
            sessionKey: scenario.sessionKey,
            revision,
          });
        };
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
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        await textarea.fill(multiline ? "Continue.\nCheck.\nReport." : "Continue the review.");
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
          message: chatMessage("assistant", "Checking the workspace."),
        });
        await updateProgress(2);
        const reply = "The review is complete.";
        await gateway.emitChatFinal({ runId, text: reply });
        await page.locator(".chat-bubble").getByText(reply, { exact: true }).waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("progressCard.get")).length)
          .toBeGreaterThan(1);
        const samples = await observation.evaluate((probe) => probe.finish());
        await observation.dispose();
        const initial = samples[0]!;
        expect(samples.filter((sample) => sample.source === "frame").length).toBeGreaterThan(1);
        const dimensions = multiline
          ? (["height", "top"] as const)
          : (["height", "top", "composerTop", "composerHeight"] as const);
        for (const sample of samples) {
          expect(sample).toMatchObject({
            retained: true,
            open: detailsOpen ? expanded : true,
            reveal: initial.reveal,
            detailsOpen,
            queueRows: 0,
          });
          for (const dimension of dimensions) {
            expect(Math.abs(sample[dimension] - initial[dimension])).toBeLessThanOrEqual(1);
          }
        }
        expect(await textarea.inputValue()).toBe("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        if (reset) {
          await updateProgress(null);
          await card.waitFor({ state: "detached" });
          await updateProgress(4);
          await card.waitFor({ state: "attached" });
          expect(await page.locator(".chat-details:popover-open").count()).toBe(
            detailsOpen ? 1 : 0,
          );
          await openChatDetails(page);
          await card.waitFor();
          expect(await card.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
        }
      });
    },
  );
});
