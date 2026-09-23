import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { formatChatWorkContext } from "../../../../../src/chat/work-context.js";
import { extractText } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { normalizeStoredQueueItem } from "../../../lib/chat/outbox-store-codec.ts";
import { buildLocalUserMessage } from "../user-message-content.ts";
import { renderMessageWorkContext } from "./chat-message-context.ts";

const container = document.createElement("div");
afterEach(() => render(html``, container));
const snapshot = {
  page: "chat",
  title: "Parser work",
  file: "src/parser.ts",
  selection: "<img src=x onerror=alert(1)>",
};
const text = "Please explain this";

describe("attached message context", () => {
  it.each(["optimistic", "history"])(
    "keeps %s text and actions separate from its inspectable context",
    (source) => {
      const message =
        source === "optimistic"
          ? buildLocalUserMessage({ text, workContext: snapshot, createdAt: 123 })
          : {
              role: "user",
              content: text + "\n\n" + formatChatWorkContext(snapshot),
              __openclaw: { workContext: { snapshot, text } },
            };
      expect(extractText(message)).toBe(text);
      expect(normalizeMessage(message).content).toEqual([{ type: "text", text }]);
      render(renderMessageWorkContext(message), container);
      const details = container.querySelector("details")!;
      expect(details.open).toBe(false);
      expect(details.querySelector("summary")?.textContent).toContain("Context attached");
      expect(details.textContent).toContain(snapshot.title);
      expect(details.querySelector("pre")?.textContent).toBe(JSON.stringify(snapshot, null, 2));
      expect(container.querySelector("img")).toBeNull();
    },
  );

  it("leaves user-pasted lookalikes alone and omits the indicator without metadata", () => {
    const content = text + "\n\n" + formatChatWorkContext(snapshot);
    const message = { role: "user", content };
    expect(extractText(message)).toBe(content);
    render(renderMessageWorkContext(message), container);
    expect(container.querySelector("details")).toBeNull();
  });

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
