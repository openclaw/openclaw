import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { renderChatQueue } from "./components/chat-composer-queue.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("queued editor focus ownership", () => {
  it.each(["elsewhere", "removed-target", "hidden-pane", "detached-pane"] as const)(
    "does not reclaim focus when an edit finishes after %s",
    async (scenario) => {
      const container = document.createElement("div");
      const other = document.createElement("input");
      document.body.append(container, other);
      const original: ChatQueueItem = {
        id: "original",
        text: "Queued message",
        createdAt: 1,
        sendState: "waiting-reconnect",
      };
      const show = (editing: boolean) =>
        render(
          html`<div class="agent-chat__composer-shell">
            ${renderChatQueue({
              queue: [editing ? original : { ...original, id: "replacement", text: "Revised" }],
              editingId: editing ? original.id : null,
              onQueueRemove: () => {},
            })}
            <div class="agent-chat__composer-combobox"><textarea>Separate draft</textarea></div>
          </div>`,
          container,
        );
      show(true);
      await expect
        .poll(() => document.activeElement?.classList.contains("chat-queue__edit-input"))
        .toBe(true);
      const composer = container.querySelector(".agent-chat__composer-combobox textarea");
      if (scenario === "elsewhere" || scenario === "removed-target") {
        other.focus();
        if (scenario === "removed-target") {
          other.remove();
        }
      } else if (scenario === "hidden-pane") {
        container.hidden = true;
      } else {
        container.remove();
      }

      show(false);
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });

      expect(container.querySelector(".chat-queue__edit-input")).toBeNull();
      expect(document.activeElement).not.toBe(composer);
      if (scenario === "elsewhere") {
        expect(document.activeElement).toBe(other);
      }
    },
  );
});
