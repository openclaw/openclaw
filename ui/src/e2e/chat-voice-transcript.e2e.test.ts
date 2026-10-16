import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const timestamp = Date.UTC(2026, 9, 14, 12);
function message(role: "user" | "assistant", text: string, id: string, extra: object = {}) {
  return { role, content: [{ type: "text", text }], timestamp, __openclaw: { id }, ...extra };
}
const backend = "It exited with code 0 and output voice-text-parity-ok.";
const speech = "It exited with code zero and output voice-text-parity-ok.";
const spoken = {
  api: "realtime",
  provider: "openai",
  model: "realtime-voice",
  stopReason: "stop",
  provenance: { kind: "realtime_voice", sourceChannel: "talk" },
};
const history = [
  message("user", "Run the text comparison once and report its output.", "typed-request"),
  message("assistant", backend, "typed-answer", { stopReason: "stop" }),
  message("user", "Now run the same check through Talk.", "voice-request"),
  message("assistant", backend, "backend-answer", {
    stopReason: "stop",
    __openclaw: { id: "backend-answer", runId: "consult" },
  }),
  message("assistant", speech, "voice-answer", {
    ...spoken,
    __openclaw: { id: "voice-answer", voiceTranscript: "provider-owned" },
  }),
];

suite.define(() => {
  it("keeps one canonical Talk result and exposes its separate speech transcript", async () => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
    });
    try {
      const page = await context.newPage();
      const gateway = await installMockGateway(page, { historyMessages: history });
      await page.goto(`${suite.server.baseUrl}chat`);
      const transcript = page.locator(".chat-thread-inner");
      await transcript.getByText(backend, { exact: true }).first().waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const frame = await takeControlUiScreenshotFrame(
          page,
          transcript,
          [transcript.getByText(backend, { exact: true }).first()],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "voice-transcript.png"), frame.png);
      }
      const disclosure = transcript.locator("details", {
        has: page.getByText("Voice transcript", { exact: true }),
      });
      await expect.poll(() => disclosure.count()).toBe(1);
      expect(await disclosure.getAttribute("open")).toBeNull();
      expect(await transcript.getByText(speech, { exact: true }).isVisible()).toBe(false);
      expect(await transcript.getByText(backend, { exact: true }).count()).toBe(2);
      await disclosure.locator("summary").click();
      await transcript.getByText(speech, { exact: true }).waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const frame = await takeControlUiScreenshotFrame(
          page,
          transcript,
          [transcript.getByText(speech, { exact: true })],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "voice-transcript-expanded.png"), frame.png);
      }
      await page.reload();
      await transcript.getByText(backend, { exact: true }).first().waitFor();
      expect(await disclosure.getAttribute("open")).toBeNull();
      await page.locator(".agent-chat__composer-combobox textarea").focus();
      await page.keyboard.press("Control+f");
      const search = page.getByRole("textbox", { name: "Search messages", exact: true });
      await search.fill("code zero");
      await transcript.getByText(speech, { exact: true }).waitFor();
      expect(await disclosure.getAttribute("open")).not.toBeNull();
      await search.press("Escape");
      await transcript.getByText(backend, { exact: true }).first().waitFor();

      // The host marker never asserts that speech replaces a particular run.
      // Speech-only dialogue stays available and unmarked chat-backed/legacy speech stays normal.
      const casualMessage = message(
        "assistant",
        "Happy to help with your next question.",
        "casual",
        {
          ...spoken,
          __openclaw: { id: "casual", seq: 6, voiceTranscript: "provider-owned" },
        },
      );
      await gateway.setHistoryMessages([...history, casualMessage]);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "agent:main:main",
        messageId: "casual",
        messageSeq: 6,
        message: casualMessage,
        session: { key: "agent:main:main", kind: "direct", updatedAt: timestamp },
      });
      const casual = transcript.locator("details", {
        hasText: "Happy to help with your next question.",
      });
      await expect.poll(() => casual.count()).toBe(1);
      await casual.locator("summary").click();
      await transcript
        .getByText("Happy to help with your next question.", { exact: true })
        .waitFor();
      const chatBacked = message(
        "assistant",
        "Chat-backed speech is the answer.",
        "chat-backed",
        spoken,
      );
      await gateway.setHistoryMessages([...history, casualMessage, chatBacked]);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "agent:main:main",
        messageId: "chat-backed",
        messageSeq: 7,
        message: chatBacked,
        session: { key: "agent:main:main", kind: "direct", updatedAt: timestamp },
      });
      await transcript.getByText("Chat-backed speech is the answer.", { exact: true }).waitFor();
      expect(
        await transcript
          .locator("details", { hasText: "Chat-backed speech is the answer." })
          .count(),
      ).toBe(0);
      // A vanished audio transport cannot remove the separately retained backend answer.
      const fallbackPage = await context.newPage();
      await installMockGateway(fallbackPage, { historyMessages: history.slice(0, -1) });
      await fallbackPage.goto(`${suite.server.baseUrl}chat`);
      const fallbackTranscript = fallbackPage.locator(".chat-thread-inner");
      await fallbackTranscript.getByText(backend, { exact: true }).first().waitFor();
      expect(await fallbackTranscript.getByText(backend, { exact: true }).count()).toBe(2);
      expect(await fallbackTranscript.locator("details").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
