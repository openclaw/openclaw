import { describe, expect, it } from "vitest";
import { stripUserEnvelopeForDisplay } from "./user-envelope-display.js";

const context =
  "[Subagent Context] You are running as a subagent (depth 1/5). Complete the current [Subagent Task]; inherited conversation is background context, not your assignment.";
const persistent =
  "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages.";
const suffix = "Begin. Execute the assigned task to completion.";

describe("stored subagent task display", () => {
  it.each([false, true])("hides only the generated envelope (persistent=%s)", (session) => {
    const task =
      "Investigate [Subagent Context] as literal task text.\n  preserve indentation\n\n" + suffix;
    const raw = [context, ...(session ? [persistent] : []), "[Subagent Task]", task, suffix].join(
      "\n\n",
    );
    expect(stripUserEnvelopeForDisplay(raw)).toBe(task);
    expect(raw).toContain(context);
    expect(stripUserEnvelopeForDisplay(context + "\n\n[Subagent Task]\n\npartial task")).toBe(
      "partial task",
    );
  });

  it.each([
    "[Subagent Context] quoted by a user\n\n[Subagent Task]\n\nkeep this",
    "[Subagent Task]\n\nkeep this",
    "Quotation:\n" + context + "\n\n[Subagent Task]\n\nkeep this",
    context + "\n\nnot a generated task",
    suffix,
    "Normal task text",
  ])("preserves ordinary and incomplete lookalike text: %s", (text) => {
    expect(stripUserEnvelopeForDisplay(text)).toBe(text);
  });
});

describe("user message-id display", () => {
  it("removes standalone message id hint lines but keeps inline mentions", () => {
    expect(stripUserEnvelopeForDisplay("hello\n[message_id: abc123]")).toBe("hello");
    expect(stripUserEnvelopeForDisplay("hello\n [message_id: abc123] \nworld")).toBe(
      "hello\nworld",
    );
    expect(stripUserEnvelopeForDisplay("[message_id: abc123]\nhello")).toBe("hello");
    expect(stripUserEnvelopeForDisplay("[message_id: abc123]")).toBe("");
    expect(stripUserEnvelopeForDisplay("hello\r\n[MESSAGE_ID: abc123]\r\nworld")).toBe(
      "hello\nworld",
    );
    expect(stripUserEnvelopeForDisplay("I typed [message_id: abc123] inline")).toBe(
      "I typed [message_id: abc123] inline",
    );
  });

  it("preserves message id examples in code", () => {
    expect(stripUserEnvelopeForDisplay("```text\n[message_id: abc123]\n```")).toBe(
      "```text\n[message_id: abc123]\n```",
    );
    expect(stripUserEnvelopeForDisplay("    [message_id: abc123]")).toBe(
      "    [message_id: abc123]",
    );
    expect(stripUserEnvelopeForDisplay("> ```text\n> [message_id: abc123]\n> ```")).toBe(
      "> ```text\n> [message_id: abc123]\n> ```",
    );
  });

  it("removes generated hints surrounding code examples", () => {
    expect(
      stripUserEnvelopeForDisplay("[message_id: generated]\n```text\n[message_id: literal]\n```"),
    ).toBe("```text\n[message_id: literal]\n```");
    expect(
      stripUserEnvelopeForDisplay("```text\n[message_id: literal]\n```\n[message_id: generated]"),
    ).toBe("```text\n[message_id: literal]\n```");
    expect(
      stripUserEnvelopeForDisplay(
        "[message_id: generated]\r\n```text\r\n[message_id: literal]\r\n```",
      ),
    ).toBe("```text\n[message_id: literal]\n```");
  });

  it("preserves CRLF code when no generated hint is removed", () => {
    expect(stripUserEnvelopeForDisplay("```text\r\n[message_id: literal]\r\n```")).toBe(
      "```text\r\n[message_id: literal]\r\n```",
    );
  });
});
