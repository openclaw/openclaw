import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { navigateToControlUiSession } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  newChatPage,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([false, true])(
    "restores a recreated reader by message and relative offset (resized=%s)",
    async (resized) => {
      const page = await newChatPage(suite);
      const sessionKey = "agent:main:main";
      const sessions = Array.from({ length: 11 }, (_, index) => ({
        key: index ? "agent:main:probe-" + index : sessionKey,
        label: "Synthetic session " + index,
        kind: "direct",
        updatedAt: 1_750_000_000_000 - index,
      }));
      const historyMessages = Array.from({ length: 100 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content:
          "Synthetic history " +
          (index + 1) +
          ".\n" +
          "Context line.\n".repeat((index % 4) + 1) +
          "Additional paragraph.\n".repeat(40),
        timestamp: 1_750_000_000_000 + index * 1_000,
        __openclaw: { id: "history-" + index, seq: index + 1 },
      }));
      await installMockGateway(page, { sessionKey, sessions, historyMessages });
      await page.goto(suite.server.baseUrl + "chat");
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      await thread.getByText("Synthetic history 100.", { exact: false }).waitFor();
      await waitForChatScrollIdle(page);
      await thread.hover();
      await page.mouse.wheel(0, -400);
      await waitForChatScrollIdle(page);
      const visible = () =>
        thread.evaluate((element) => {
          const viewport = element.getBoundingClientRect();
          return [...element.querySelectorAll<HTMLElement>("[data-message-id]")]
            .filter((message) => {
              const bounds = message.getBoundingClientRect();
              return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
            })
            .map((message) => ({
              id: message.dataset.messageId,
              top: message.getBoundingClientRect().top - viewport.top,
            }));
        });
      const before = await visible();
      const anchor = expectDefined(before[0], "visible reader message");
      const capture = async (name: string) => {
        if (!captureUiProofEnabled) {
          return;
        }
        const frame = await takeControlUiScreenshotFrame(page, thread, [], {
          animations: "disabled",
        });
        await writeFile(
          path.join(suite.artifactDir, name + (resized ? "-resized" : "") + ".png"),
          frame.png,
        );
      };
      await capture("reader-before-navigation");
      for (const session of sessions.slice(1)) {
        await navigateToControlUiSession(page, session.key);
        await waitForChatScrollIdle(page);
      }
      if (resized) {
        await page.setViewportSize({ width: 640, height: 844 });
      }
      await navigateToControlUiSession(page, sessionKey);
      await waitForChatScrollIdle(page);
      const after = await visible();
      await capture("reader-after-return");
      console.log(JSON.stringify({ before, after, artifactDir: suite.artifactDir }));
      const restored = expectDefined(
        after.find((message) => message.id === anchor.id),
        "restored reader message",
      );
      expect(Math.abs(restored.top - anchor.top)).toBeLessThanOrEqual(1);
      if (!resized) {
        expect(after.map((message) => message.id)).toEqual(before.map((message) => message.id));
      }
    },
  );
});
