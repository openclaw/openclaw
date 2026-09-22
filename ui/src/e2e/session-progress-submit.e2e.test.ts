import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import {
  observeProgressSubmit,
  progressSubmitScenario,
} from "./session-progress-submit.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { name: "collapsed desktop", mobile: false, expanded: false, multiline: false },
    { name: "header-closed desktop", mobile: false, expanded: false, multiline: false },
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
        const card = page.locator(".session-progress-card--composer");
        await card.waitFor();
        await waitForChatScrollIdle(page);
        if (mobile) {
          await captureUiProof(suite, page, "mobile-progress", "initial.png");
        }
        expect(await card.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
          !mobile,
        );
        if (name === "header-closed desktop") {
          await card.locator("summary").hover();
          await page.mouse.wheel(0, 400);
          await expect
            .poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open))
            .toBe(false);
        } else if (mobile ? expanded : !expanded) {
          await card.locator("summary").click();
        }
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        await textarea.fill(
          multiline
            ? "Please continue.\nCheck the changes.\nShare the result."
            : "Please continue the review.",
        );
        await waitForChatScrollIdle(page);
        const observation = await observeProgressSubmit(page);
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
        if (name === "header-closed desktop") {
          await captureUiProof(suite, page, "header-closed", "after-send.png");
        }
        const initial = samples[0]!;
        expect(samples.filter((sample) => sample.source === "frame").length).toBeGreaterThan(1);
        expect(
          samples.every(
            (sample) =>
              sample.retained && sample.open === initial.open && sample.reveal === initial.reveal,
          ),
        ).toBe(true);
        expect(samples.every((sample) => Math.abs(sample.height - initial.height) <= 1)).toBe(true);
        expect(samples.every((sample) => sample.queueRows === 0)).toBe(true);
        expect(samples.every((sample) => Math.abs(sample.stackGap - initial.stackGap) <= 1)).toBe(
          true,
        );
        if (!multiline) {
          expect(samples.every((sample) => Math.abs(sample.top - initial.top) <= 1)).toBe(true);
          expect(
            samples.every(
              (sample) => Math.abs(sample.composerHeight - initial.composerHeight) <= 1,
            ),
          ).toBe(true);
        }
        expect(initial.open).toBe(expanded);
        if (mobile) {
          await captureUiProof(suite, page, "mobile-progress", "after-send.png");
        }
        expect(await textarea.inputValue()).toBe("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
