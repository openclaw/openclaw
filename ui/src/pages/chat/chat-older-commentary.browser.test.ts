import { expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import "../../styles.css";
import "../../styles/chat.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { createChatProps, disposeChatView, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { createChatTranscript } from "./components/chat-transcript-controller.ts";

it.each([false, true])(
  "keeps paged older commentary above unrelated input (retained output=%s)",
  async (retainedOutput) => {
    await page.viewport(1200, 900);
    const fixture = createComposerContainer();
    fixture.style.cssText = "display:block;height:900px;width:100%";
    document.body.append(fixture);
    onTestFinished(() => {
      disposeChatView(fixture);
      fixture.remove();
    });
    const props = createChatProps({
      transcript: createChatTranscript(() => "older-commentary", { canFollowEnd: () => true }),
      paneId: "older-commentary",
      assistantName: "Assistant",
      runId: "next",
      runActive: true,
      messages: [
        ...(retainedOutput
          ? [
              {
                role: "assistant",
                content: "Retained older answer",
                timestamp: 10,
                __openclaw: { id: "old-answer", runId: "older", seq: 2 },
              },
            ]
          : []),
        {
          role: "user",
          content: "Unrelated intervening request",
          timestamp: 15,
          __openclaw: { id: "intervening", idempotencyKey: "intervening:user", seq: 3 },
        },
        {
          role: "user",
          content: "Later current request",
          timestamp: 20,
          __openclaw: { id: "next-input", idempotencyKey: "next:user", seq: 4 },
        },
      ],
      streamSegments: [
        {
          text: "Older commentary",
          ts: 9000,
          runId: "older",
          itemId: "old-comment",
          ...(retainedOutput ? {} : { afterUserSendId: "paged-original" }),
        },
      ],
    });
    renderChatPropsInto(fixture, props);
    const texts = () =>
      [...fixture.querySelectorAll(".chat-text")].map((node) => node.textContent?.trim());
    await expect.poll(() => texts().length).toBe(retainedOutput ? 4 : 3);
    const expected = [
      ...(retainedOutput ? ["Retained older answer"] : []),
      "Older commentary",
      "Unrelated intervening request",
      "Later current request",
    ];
    expect(texts()).toEqual(expected);
  },
);
