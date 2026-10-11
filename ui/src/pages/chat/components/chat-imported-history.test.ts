import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapExternalContent } from "../../../../../src/security/external-content.js";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { extractText, extractTextCached } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import {
  prepareChatMessageRender,
  MessageActions,
  resolveMessageActionDetails,
} from "./chat-message-markdown.ts";

const importKey = "example-catalog:thread:item";
const wrap = (text: string) =>
  wrapExternalContent(text, { source: "unknown", includeWarning: false }).trim();
const container = document.createElement("div");

afterEach(() => {
  render(nothing, container);
  vi.unstubAllGlobals();
});

function displayed(message: unknown) {
  return resolveMessageDisplayMarkdown(message, normalizeMessage(message));
}

it("hides import framing in text content without mutating history", () => {
  const body = "A **message**\n\n---\n\nSource: External\n\n~~~ts\nconst answer = 42;\n~~~";
  const message = {
    role: "user",
    text: wrap(body),
    __openclaw: { idempotencyKey: importKey },
  };
  const original = structuredClone(message);
  expect(extractText(message)).toBe(body);
  expect(extractTextCached(message)).toBe(body);
  expect(displayed(message)).toBe(body);
  expect(message).toEqual(original);
});

describe.each(["user", "assistant"])("imported %s history presentation", (role) => {
  it("unwraps text blocks independently and preserves other content", () => {
    const message = {
      role,
      idempotencyKey: importKey,
      content: [
        { type: "text", text: wrap("First") },
        null,
        { type: role === "user" ? "input_text" : "output_text", text: wrap("Second") },
      ],
    };
    expect(extractText(message)).toBe("First\nSecond");
    expect(displayed(message)).toBe("First\nSecond");
  });

  it("renders the body as Markdown and uses it for reply and copy actions", async () => {
    const body = "Imported **answer**\n\n~~~ts\nconst answer = 42;\n~~~";
    const message = { role, content: wrap(body), __openclaw: { idempotencyKey: importKey } };
    render(
      renderGroupedMessage(prepareChatMessageRender(message), "imported", {
        isStreaming: false,
        showReasoning: false,
      }),
      container,
    );
    expect(container.querySelector(".chat-text strong")?.textContent).toBe("answer");
    expect(container.querySelector("pre code")?.textContent?.trimEnd()).toBe("const answer = 42;");
    expect(container.textContent).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(container.textContent).not.toContain("Source: External");
    expect(container.querySelector("h2")).toBeNull();
    const onReply = vi.fn();
    const details = resolveMessageActionDetails(prepareChatMessageRender(message), {
      messageId: "imported",
      senderLabel: role,
      onReply,
    });
    expect(details?.replyTarget?.text).toBe(body);
    if (role === "assistant") {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      expect(details?.markdown).toBe(body);
      render(solidContent(MessageActions, { details, options: { onReply } }), container);
      container.querySelector<HTMLButtonElement>(".chat-copy-btn")!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
    }
  });
});

describe("imported history framing", () => {
  const role = "assistant";

  it("retains warning-bearing external content", () => {
    const content = wrapExternalContent("Evidence", { source: "unknown" }).trim();
    const message = { role, content, __openclaw: { idempotencyKey: importKey } };
    expect(extractText(message)).toBe(content);
    expect(displayed(message)).toBe(content);
  });

  it("does not reinterpret an ordinary message that quotes a complete wrapper", () => {
    const content = wrap("A literal wrapper example");
    for (const metadata of [{}, { idempotencyKey: "ordinary:user" }]) {
      const message = { role, content, __openclaw: metadata };
      expect(extractText(message)).toBe(content);
      expect(displayed(message)).toBe(content);
    }
  });
});

it("does not hide security framing in tool output", () => {
  const content = wrap("Tool evidence");
  expect(
    extractText({ role: "toolResult", content, __openclaw: { idempotencyKey: importKey } }),
  ).toBe(content);
});
