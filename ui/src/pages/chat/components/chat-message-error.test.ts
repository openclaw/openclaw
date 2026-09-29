/* @vitest-environment jsdom */
import { render } from "lit";
import { expect, it } from "vitest";
import { t } from "../../../i18n/index.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";

it.each(["custom", "assistant"] as const)(
  "preserves grouped repeat counts on %s diagnostic cards",
  (role) => {
    const content = ["Error: Request failed.", "Retry after checking the configuration."].join(
      String.fromCharCode(10),
    );
    const message = {
      role,
      customType: "run-failed-before-reply",
      stopReason: "error",
      errorMessage: content,
      content,
      __openclaw: { id: "failure", runId: "run-1" },
    };
    const host = document.createElement("div");
    const draw = (duplicateCount: number) =>
      render(
        renderGroupedMessage(prepareChatMessageRender(message), "failure", {
          isStreaming: false,
          showReasoning: false,
          duplicateCount,
        }),
        host,
      );
    draw(2);
    expect(host.querySelectorAll(".chat-error")).toHaveLength(1);
    expect(host.querySelectorAll(".chat-duplicate-count")).toHaveLength(1);
    const badge = host.querySelector(".chat-bubble > .chat-duplicate-count");
    expect(badge?.textContent?.trim()).toBe("×2");
    expect(badge?.getAttribute("aria-label")).toBe(
      t("chat.messages.duplicatesCollapsed", { count: "2" }),
    );
    expect(host.querySelector(".chat-error__diagnostic")?.textContent?.trim()).toBe(content);
    expect(message.content).toBe(content);
    draw(1);
    expect(host.querySelectorAll(".chat-error")).toHaveLength(1);
    expect(host.querySelector(".chat-duplicate-count")).toBeNull();
  },
);
