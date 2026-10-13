/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("message copy actions", () => {
  it.each(["user", "assistant"])(
    "copies each %s message's full markdown without Reply enabled",
    (role) => {
      vi.useFakeTimers();
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const container = document.createElement("div");
      const texts = ["First **message**.", `${"Long prompt 😀\n".repeat(100)}Final line.`];
      const messages = texts.map((content, index) => ({
        key: `copy-message-${index}`,
        message: { role, content, timestamp: index + 1 },
      }));
      render(
        renderMessageGroup(createMessageGroup(messages[0]!.message, role, { messages }), {
          showReasoning: true,
          showToolCalls: true,
        }),
        container,
      );

      const buttons = container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Copy as markdown"]',
      );
      expect(buttons).toHaveLength(texts.length);
      buttons.forEach((button, index) => {
        button.click();
        expect(writeText).toHaveBeenNthCalledWith(index + 1, texts[index]);
      });
    },
  );
});
