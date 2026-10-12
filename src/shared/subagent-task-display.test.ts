import { describe, expect, it } from "vitest";
import { stripSubagentTaskEnvelopeForDisplay } from "./subagent-task-display.js";

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
    expect(stripSubagentTaskEnvelopeForDisplay(raw)).toBe(task);
    expect(raw).toContain(context);
    expect(
      stripSubagentTaskEnvelopeForDisplay(context + "\n\n[Subagent Task]\n\npartial task"),
    ).toBe("partial task");
  });

  it.each([
    "[Subagent Context] quoted by a user\n\n[Subagent Task]\n\nkeep this",
    "[Subagent Task]\n\nkeep this",
    "Quotation:\n" + context + "\n\n[Subagent Task]\n\nkeep this",
    context + "\n\nnot a generated task",
    suffix,
    "Normal task text",
  ])("preserves ordinary and incomplete lookalike text: %s", (text) => {
    expect(stripSubagentTaskEnvelopeForDisplay(text)).toBe(text);
  });
});
