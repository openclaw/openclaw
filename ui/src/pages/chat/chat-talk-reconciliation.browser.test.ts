import { LitElement } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import "../../styles/chat.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import { ChatTranscriptController } from "./components/chat-transcript-controller.ts";

class TalkReconciliationFixture extends LitElement {
  readonly transcript = new ChatTranscriptController(this, { canFollowEnd: () => true });
  saved = false;
  protected override createRenderRoot() {
    return this;
  }
  protected override render() {
    return renderChat(
      createChatProps({
        transcript: this.transcript,
        paneId: "talk-reconciliation",
        assistantName: "Assistant",
        realtimeTalkActive: true,
        messages: this.saved
          ? [
              {
                role: "user",
                content: "Tell me about otters.",
                __openclaw: { id: "voice:call:1" },
              },
              {
                role: "assistant",
                content: "Otters use rocks to open shellfish.",
                __openclaw: { id: "voice:call:2" },
              },
            ]
          : [],
        realtimeTalkConversation: [
          {
            id: "rt-1",
            role: "user",
            text: "Tell me about otters.",
            isStreaming: false,
            transcriptId: "voice:call:1",
          },
          {
            id: "rt-2",
            role: "assistant",
            text: "Otters use rocks to open shellfish.",
            isStreaming: false,
            transcriptId: "voice:call:2",
          },
          { id: "rt-3", role: "user", text: "Now check the room temperature.", isStreaming: true },
        ],
      }),
    );
  }
}
customElements.define("test-talk-reconciliation", TalkReconciliationFixture);
let fixture: TalkReconciliationFixture | undefined;
afterEach(() => {
  fixture?.remove();
  fixture = undefined;
});
it("reconciles persisted voice while preserving the live tail", async () => {
  await page.viewport(1440, 900);
  fixture = new TalkReconciliationFixture();
  fixture.style.cssText = "display:block;height:900px;width:100%";
  document.body.append(fixture);
  await fixture.updateComplete;
  await expect.poll(() => fixture!.querySelectorAll(".agent-chat__voice-turn").length).toBe(3);
  fixture.saved = true;
  fixture.requestUpdate();
  await fixture.updateComplete;
  expect(fixture.querySelectorAll(".agent-chat__voice-turn")).toHaveLength(1);
  const renderedMessages = [...fixture.querySelectorAll(".chat-text")]
    .map((element) => element.textContent)
    .join("\n");
  expect(renderedMessages.match(/Tell me about otters\./g)).toHaveLength(1);
  expect(renderedMessages.match(/Otters use rocks to open shellfish\./g)).toHaveLength(1);
  expect(fixture.querySelector(".agent-chat__voice-turn")?.textContent).toContain(
    "Now check the room temperature.",
  );
});
