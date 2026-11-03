import { expect, it } from "vitest";
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
  message("assistant", backend, "typed-answer", spoken),
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
  it("keeps one canonical Talk result and exposes its separate speech transcript", () =>
    suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "light" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { historyMessages: history });
        await page.goto(`${suite.server.baseUrl}chat`);
        const transcript = page.locator(".chat-thread-inner");
        await transcript.getByText(backend, { exact: true }).first().waitFor();
        const disclosure = transcript.locator("details", {
          has: page.getByText("Voice transcript", { exact: true }),
        });
        await expect.poll(() => disclosure.count()).toBe(1);
        expect(await transcript.locator("details").count()).toBe(1);
        expect(await disclosure.getAttribute("open")).toBeNull();
        expect(await transcript.getByText(speech, { exact: true }).isVisible()).toBe(false);
        expect(await transcript.getByText(backend, { exact: true }).count()).toBe(2);
        await disclosure.locator("summary").click();
        await transcript.getByText(speech, { exact: true }).waitFor();
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

        // Speech-only dialogue remains available without a backing answer.
        const casualText = "Happy to help with your next question.";
        const casualMessage = message("assistant", casualText, "casual", {
          ...spoken,
          __openclaw: { id: "casual", seq: 6, voiceTranscript: "provider-owned" },
        });
        const publish = async (messages: typeof history, messageId: string, messageSeq: number) => {
          await gateway.setHistoryMessages(messages);
          await gateway.emitGatewayEvent("session.message", {
            sessionKey: "agent:main:main",
            messageId,
            messageSeq,
            message: messages.at(-1),
            session: { key: "agent:main:main", kind: "direct", updatedAt: timestamp },
          });
        };
        await publish([...history, casualMessage], "casual", 6);
        const casual = transcript.locator("details", { hasText: casualText });
        await expect.poll(() => casual.count()).toBe(1);
        await casual.locator("summary").click();
        await transcript.getByText(casualText, { exact: true }).waitFor();
      },
    ));
});
