import { writeFileSync } from "node:fs";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat text-only selection" });
const first = "Select this message without painting its image or surrounding space.";
const last = "Selection ends here, with only the conversation text highlighted.";

suite.define(() => {
  it.each(["dark", "light"] as const)("paints only text in %s mode", async (colorScheme) => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: first }] },
            {
              role: "user",
              content: [
                { type: "text", text: "Keep this image untouched." },
                {
                  type: "image",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
                  mimeType: "image/png",
                  alt: "Selection proof image",
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text:
                    "A paragraph with **bold text**, a [link](https://example.com), and selectable code.\n\n- A selectable list item\n\n" +
                    last,
                },
              ],
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("chat.startup");
        const thread = page.locator(".chat-thread");
        const start = page.getByText(first, { exact: true });
        const end = page.getByText(last, { exact: true });
        const image = page.getByAltText("Selection proof image");
        const capture = async () =>
          takeControlUiScreenshotFrame(page, thread, [start, end, image], {
            animations: "disabled",
            elements: [image, start],
          });
        const unselected = await capture();
        const points = await page.evaluate(
          ({ first: firstText, last: lastText }) => {
            const paragraphs = [...document.querySelectorAll(".chat-text p")];
            const firstNode = paragraphs.find((p) => p.textContent === firstText)!.firstChild!;
            const lastNode = paragraphs.find((p) => p.textContent === lastText)!.firstChild!;
            const position = (node: Node, offset: number) => {
              const range = document.createRange();
              range.setStart(node, offset);
              range.setEnd(node, offset + 1);
              const rect = range.getBoundingClientRect();
              return { x: rect.x + 1, y: rect.y + rect.height / 2 };
            };
            return { start: position(firstNode, 0), end: position(lastNode, lastText.length - 1) };
          },
          { first, last },
        );
        await page.mouse.move(points.start.x, points.start.y);
        await page.mouse.down();
        await page.mouse.move(points.end.x + 8, points.end.y, { steps: 12 });
        await page.mouse.up();
        const selectedText = await page.evaluate(() => window.getSelection()?.toString());
        expect(selectedText).toContain(first);
        expect(selectedText).toContain(last);
        expect(selectedText).toContain("bold text");
        await thread.focus();
        await page.keyboard.press("ControlOrMeta+A");
        const allText = await page.evaluate(() => window.getSelection()?.toString());
        expect(allText).toContain(first);
        expect(allText).toContain(last);
        const selected = await capture();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          writeFileSync(path.join(suite.artifactDir, colorScheme + "-selected.png"), selected.png);
        }
        const beforeImage = photon.PhotonImage.new_from_byteslice(unselected.elements[0]!.png);
        const afterImage = photon.PhotonImage.new_from_byteslice(selected.elements[0]!.png);
        try {
          expect(
            Buffer.from(afterImage.get_raw_pixels()).equals(
              Buffer.from(beforeImage.get_raw_pixels()),
            ),
            "selection must not tint the image",
          ).toBe(true);
        } finally {
          beforeImage.free();
          afterImage.free();
        }
        const beforeFrame = photon.PhotonImage.new_from_byteslice(unselected.png);
        const afterFrame = photon.PhotonImage.new_from_byteslice(selected.png);
        try {
          const bounds = await start.boundingBox();
          const x = Math.floor(bounds!.x - 12);
          const y = Math.floor(bounds!.y + bounds!.height + 12);
          const offset = (y * beforeFrame.get_width() + x) * 4;
          expect(
            afterFrame.get_raw_pixels().slice(offset, offset + 4),
            "selection must not paint the turn gap",
          ).toEqual(beforeFrame.get_raw_pixels().slice(offset, offset + 4));
        } finally {
          beforeFrame.free();
          afterFrame.free();
        }
        expect(allText).not.toContain("Just now");
        expect(selectedText).not.toContain("OpenClaw");
        expect(selectedText).not.toContain("Just now");
        expect(
          selected.elements[1]!.png.equals(unselected.elements[1]!.png),
          "native selection must visibly paint the message text",
        ).toBe(false);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });

  it.each([false, true])("keeps reasoning selectable with bubbles=%s", async (bubbles) => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "dark" },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:selection-reasoning";
        const reasoningText = "Reasoning prose remains selectable.";
        const answerText = "The answer remains selectable too.";
        await page.addInitScript(
          ({ key, session, enabled }) => {
            localStorage.setItem(
              key,
              JSON.stringify({
                chatBubbleSessionKeys: enabled ? [session] : [],
                chatShowThinking: true,
              }),
            );
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            session: sessionKey,
            enabled: bubbles,
          },
        );
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionInfo: { reasoningLevel: "on" },
          sessions: [{ key: sessionKey, kind: "direct", reasoningLevel: "on" }],
          historyMessages: [
            { role: "assistant", content: [{ type: "thinking", thinking: reasoningText }] },
            { role: "assistant", content: [{ type: "text", text: answerText }] },
          ],
        });
        await page.route("**/control-ui-config.json", (route) =>
          route.fulfill({
            json: { ...createControlUiMockBootstrapConfig(), chatBubblesEnabled: true },
          }),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const answer = pane.getByText(answerText, { exact: true });
        await answer.waitFor();
        const work = pane.locator(".chat-work-group > .chat-activity-group__summary");
        if (await work.count()) {
          await work.click();
        }
        const disclosure = pane.locator('.chat-bubble-activity__summary[aria-label="Reasoning"]');
        if (await disclosure.count()) {
          await disclosure.click();
        }
        const reasoning = pane.locator(".chat-thinking").getByText(reasoningText, { exact: true });
        await reasoning.waitFor();
        await reasoning.scrollIntoViewIfNeeded();
        const box = await reasoning.boundingBox();
        if (!box) {
          throw new Error("Reasoning text has no rendered bounds");
        }
        await page.mouse.move(box.x + 1, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
        await page.mouse.up();
        expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
          reasoningText,
        );
        await pane.locator(".chat-thread").focus();
        await page.keyboard.press("ControlOrMeta+A");
        const selection = await page.evaluate(() => window.getSelection()?.toString());
        expect(selection).toContain(reasoningText);
        expect(selection).toContain(answerText);
        expect(selection).not.toContain("Just now");
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" && bubbles) {
          const frame = await takeControlUiScreenshotFrame(page, pane, [reasoning, answer], {
            animations: "disabled",
          });
          writeFileSync(path.join(suite.artifactDir, "reasoning-bubbles-selected.png"), frame.png);
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
