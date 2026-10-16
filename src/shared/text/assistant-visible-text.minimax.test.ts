import { describe, expect, it, vi } from "vitest";
import {
  assistantVisibleTextFilters,
  minimaxToolCallTextFilter,
  sanitizeAssistantVisibleTextWithProfile,
} from "./assistant-visible-text.js";
import { createTextProjection } from "./text-projection.js";

describe("encoded MiniMax tool envelopes", () => {
  it("removes the internal envelope and retains surrounding prose in final answers", () => {
    const input = [
      "Before",
      "]<]minimax[>[<tool_call>",
      ']<]minimax[>[<invoke name="exec">]<]minimax[>[<command>printf PRIVATE_PAYLOAD]<]minimax[>[</command>',
      "]<]minimax[>[</invoke>]<]minimax[>[</tool_call>",
      "After",
    ].join("\n");
    expect(sanitizeAssistantVisibleTextWithProfile(input, "final-answer-delivery")).toBe(
      "Before\n\nAfter",
    );
  });

  it.each([
    [
      "fenced code",
      '```xml\n]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>\n```',
    ],
    ["a standalone delimiter", "The literal ]<]minimax[>[ delimiter is not a tool call."],
  ])("preserves %s", (_name, input) => {
    expect(sanitizeAssistantVisibleTextWithProfile(input, "delivery")).toBe(input);
  });

  it("ignores a false closer in code and removes the complete internal envelope", () => {
    const input = [
      "Before",
      "]<]minimax[>[<tool_call>",
      "Example: `]<]minimax[>[</tool_call>`",
      ']<]minimax[>[<invoke name="exec">PRIVATE_PAYLOAD</invoke>',
      "]<]minimax[>[</tool_call>",
      "After",
    ].join("\n");
    expect(sanitizeAssistantVisibleTextWithProfile(input, "delivery")).toBe("Before\n\nAfter");
  });

  it("preserves encoded text in the internal-scaffolding profile", () => {
    const input =
      'Before ]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">payload</invoke>]<]minimax[>[</tool_call> After';
    expect(sanitizeAssistantVisibleTextWithProfile(input, "internal-scaffolding")).toBe(input);
  });

  it("stops searching after no closer exists for repeated incomplete openings", () => {
    const input = "]<]minimax[>[<tool_call>\n".repeat(256);
    const closeSource = "\\]?<\\]minimax\\[>\\[<\\/tool_call>";
    const exec = vi.spyOn(RegExp.prototype, "exec");

    let output: string;
    let closeSearches: number;
    try {
      output = minimaxToolCallTextFilter.transform(input);
      closeSearches = exec.mock.contexts.filter(
        (context) => context instanceof RegExp && context.source === closeSource,
      ).length;
    } finally {
      exec.mockRestore();
    }
    expect(output).toBe(input);
    expect(closeSearches).toBe(1);
  });

  it("replaces already projected text when a split encoded envelope closes", () => {
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));

    const prefix = "Before ]<]mini";
    const payload = 'max[>[<tool_call>]<]minimax[>[<invoke name="exec">secret</invoke>';
    const closing = "]<]minimax[>[</tool_call>After";
    expect(projection.append(prefix)).toEqual({ text: prefix, delta: prefix });
    expect(projection.append(payload)).toEqual({ text: prefix + payload, delta: payload });
    expect(projection.append(closing)).toEqual({ text: "Before After", delta: null });
    expect(projection.append(".")).toEqual({ text: "Before After.", delta: "." });
  });

  it("preserves a code example when it replaces previously filtered source", () => {
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
    projection.append(
      'Before ]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">secret</invoke>]<]minimax[>[</tool_call>After',
    );

    const example =
      'Use `]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>`.';
    expect(projection.replace(example)).toEqual({ text: example, delta: null });
    expect(projection.append(" Kept.")).toEqual({ text: `${example} Kept.`, delta: " Kept." });
  });
});
