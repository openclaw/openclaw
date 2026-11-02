/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { AnswerLens, ORIGINAL_LENS } from "../answer-lens.ts";
import { createChatMessageHarness } from "./chat-message-render.test-support.tsx";
import { createAssistantMessage, createMessageGroup } from "./chat-message.test-support.ts";

const harness = createChatMessageHarness();
const original =
  "An explanation with its original qualifications and supporting details. The underlying evidence remains uncertain, so this is not a guarantee.";

describe("Answer Lens native message integration", () => {
  it.each([false, true])(
    "renders variants and resets in bubble mode %s without changing replies",
    async (bubbleMode) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
      const request = createGatewayRequestMock();
      const owner = new AnswerLens();
      owner.configure({
        client: createTestGatewayClient(request),
        sessionKey: "agent:test:lens",
        epoch: 1,
      });
      const message = createAssistantMessage(original, {
        __openclaw: { id: "lens-source", seq: 1 },
      });
      const onReply = vi.fn();
      harness.markdownRenderMock.withImplementation(harness.renderMarkdownHtml, () => {
        harness.render(
          harness.renderTestMessageGroup(createMessageGroup(message, "assistant"), {
            answerLens: owner,
            sessionKey: "agent:test:lens",
            bubbleMode,
            onReply,
          }),
        );
      });
      expect(harness.view.querySelector('[aria-label="Length"]')).not.toBeNull();
      request.mockResolvedValueOnce({
        text: original,
        sourceRevision: "rev",
        messageId: "lens-source",
        ...ORIGINAL_LENS,
        durationMs: 0,
      });
      request.mockResolvedValueOnce({
        text: "Evidence is uncertain—not a guarantee.",
        sourceRevision: "rev",
        messageId: "lens-source",
        wording: "plain",
        coverage: "gist",
        durationMs: 12,
      });
      await owner.select(
        { messageId: "lens-source", text: original },
        { wording: "plain", coverage: "gist" },
      );
      await waitForSolid(() =>
        expect(harness.view.querySelector(".chat-text")?.textContent).toContain(
          "Evidence is uncertain",
        ),
      );
      expect(harness.view.querySelector(".answer-lens-status")?.textContent).toContain("Simple");
      harness.view
        .querySelector<HTMLButtonElement>(".chat-group-footer-actions .chat-copy-btn")!
        .click();
      await waitForSolid(() =>
        expect(writeText).toHaveBeenCalledWith("Evidence is uncertain—not a guarantee."),
      );
      const bubble = harness.view.querySelector<HTMLElement>("[data-message-text]");
      expect(bubble?.dataset.messageText).toBe("Evidence is uncertain—not a guarantee.");
      const reply = harness.view.querySelector<HTMLButtonElement>(
        '[aria-label="Reply to message"]',
      );
      reply!.click();
      expect(onReply.mock.calls[0]?.[0].text).toBe(original);
      await owner.select({ messageId: "lens-source", text: original }, ORIGINAL_LENS);
      await waitForSolid(() =>
        expect(harness.view.querySelector(".chat-text")?.textContent).toContain(original),
      );
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
});
