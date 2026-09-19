import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
const suite = createChatFlowE2eSuite();
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR;
type MotionArrival = { text: string; opacity: string; transform: string };

declare global {
  interface Window {
    openclawMotionArrivals?: MotionArrival[];
  }
}

suite.define(() => {
  it.each([
    { name: "desktop", width: 1280, height: 900, reducedMotion: "no-preference" as const },
    { name: "mobile", width: 390, height: 844, reducedMotion: "no-preference" as const },
    { name: "reduced-motion", width: 1280, height: 900, reducedMotion: "reduce" as const },
  ])(
    "shows one CSS arrival per send and reply on $name",
    async ({ name, width, height, reducedMotion }) => {
      const viewport = { width, height };
      const dir = createControlUiE2eArtifactDir(`chat-motion-${name}`, artifactDir);
      const context = await suite.newBrowserContext({
        viewport,
        reducedMotion,
        ...(dir ? { recordVideo: { dir, size: viewport } } : {}),
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const arrivals: MotionArrival[] = [];
        window.openclawMotionArrivals = arrivals;
        document.addEventListener("animationstart", (event) => {
          if (
            event.animationName !== "chat-message-enter" ||
            !(event.target instanceof HTMLElement)
          ) {
            return;
          }
          const style = getComputedStyle(event.target);
          arrivals.push({
            text: event.target.dataset.messageText ?? "",
            opacity: style.opacity,
            transform: style.transform,
          });
        });
      });
      const gateway = await installMockGateway(page, {
        historyMessages: Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: [
            {
              type: "text",
              text:
                "Existing message " +
                index +
                "\nA retained conversation with enough detail to scroll.",
            },
          ],
          timestamp: Date.now() - (40 - index) * 60_000,
          __openclaw: { id: "old-" + index, seq: index + 1 },
        })),
      });
      try {
        await page.goto(suite.server.baseUrl + "chat");
        await page.getByText("Existing message 39", { exact: false }).waitFor();
        await waitForChatScrollIdle(page);
        expect(await page.evaluate(() => window.openclawMotionArrivals)).toHaveLength(0);
        if (dir) {
          await page.screenshot({ path: path.join(dir, "01-history.png") });
        }
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Make this feel fast and smooth");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(request.params).idempotencyKey, "run id");
        const expected = reducedMotion === "reduce" ? 0 : 1;
        const sendBubble = page.locator(
          '.chat-bubble[data-message-text="Make this feel fast and smooth"]',
        );
        await expect
          .poll(() => sendBubble.evaluate((el) => getComputedStyle(el).opacity))
          .toBe("1");
        if (dir) {
          await page.screenshot({ path: path.join(dir, "02-prompt.png") });
        }
        let text = "A responsive reply, without a jump.";
        const emit = async () =>
          gateway.emitGatewayEvent("chat", {
            sessionKey: "main",
            runId,
            state: "delta",
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            },
          });
        await emit();
        await page.locator(".chat-bubble").getByText(text, { exact: true }).waitFor();
        for (let index = 0; index < 3; index++) {
          text += " More streaming text.";
          await emit();
          await page.locator(".chat-bubble").getByText(text, { exact: true }).waitFor();
        }
        await waitForChatScrollIdle(page);
        if (dir) {
          await page.screenshot({ path: path.join(dir, "03-reply.png") });
        }
        expect(await page.evaluate(() => window.openclawMotionArrivals)).toHaveLength(expected * 2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
