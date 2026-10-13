import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { formatChatWorkContext } from "../../../../../src/chat/work-context.js";
import { extractText } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { normalizeStoredQueueItem } from "../../../lib/chat/outbox-store-codec.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import { buildLocalUserMessage } from "../user-message-content.ts";
import { MessageWorkContext } from "./chat-message-context-view.tsx";

const container = document.createElement("div");
afterEach(() => render(html``, container));
const snapshot = {
  page: "review:board",
  detail: { filter: "stuck" },
  title: "Parser work",
  file: "src/parser.ts",
  selection: "<img src=x onerror=alert(1)>",
};
const text = "Please explain this";

describe("attached message context", () => {
  it.each(["optimistic", "history", "pasted"])(
    "distinguishes attached context from pasted text for %s messages",
    (source) => {
      const message =
        source === "optimistic"
          ? buildLocalUserMessage({ text, workContext: snapshot, createdAt: 123 })
          : {
              role: "user",
              content: text + "\n\n" + formatChatWorkContext(snapshot),
              ...(source === "history" ? { __openclaw: { workContext: { snapshot, text } } } : {}),
            };
      render(solidContent(MessageWorkContext, { message }), container);
      if (source === "pasted") {
        expect(extractText(message)).toBe(text + "\n\n" + formatChatWorkContext(snapshot));
        expect(container.querySelector("details")).toBeNull();
        return;
      }
      expect(extractText(message)).toBe(text);
      expect(normalizeMessage(message).content).toEqual([{ type: "text", text }]);
      const details = container.querySelector("details")!;
      expect(details.open).toBe(false);
      expect(details.querySelector("summary")?.textContent).toContain("Context attached");
      expect(details.textContent).toContain(snapshot.title);
      expect(details.querySelector("pre")?.textContent).toBe(JSON.stringify(snapshot, null, 2));
      expect(container.querySelector("img")).toBeNull();
    },
  );

  it("restores a captured outbox snapshot and retains a damaged row for explicit recovery", () => {
    const input = { id: "queued", text, createdAt: 123, workContext: snapshot };
    // Exercise the outbox JSON storage format, not an in-memory object clone.
    const storedJson = JSON.stringify(input);
    expect(normalizeStoredQueueItem(JSON.parse(storedJson))).toMatchObject(input);
    expect(normalizeStoredQueueItem({ ...input, workContext: { page: 42 } })).toMatchObject({
      text,
      sendState: "failed",
      workContextUnavailable: true,
    });
  });
});
