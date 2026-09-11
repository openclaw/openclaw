import { describe, expect, it, vi } from "vitest";
import {
  assistantVisibleTextFilters,
  sanitizeAssistantVisibleTextWithProfile,
  stripMinimaxToolCallXml,
} from "./assistant-visible-text.js";
import { createTextProjection } from "./text-projection.js";

describe("encoded MiniMax tool envelopes", () => {
  it.each(["delivery", "final-answer-delivery", "history"] as const)(
    "removes the internal envelope and retains surrounding prose in %s",
    (profile) => {
      const input = [
        "Before",
        "]<]minimax[>[<tool_call>",
        ']<]minimax[>[<invoke name="exec">]<]minimax[>[<command>printf PRIVATE_PAYLOAD]<]minimax[>[</command>',
        "]<]minimax[>[</invoke>]<]minimax[>[</tool_call>",
        "After",
      ].join("\n");

      expect(sanitizeAssistantVisibleTextWithProfile(input, profile)).toBe("Before\n\nAfter");
    },
  );

  it.each([
    {
      name: "inline code",
      input:
        'Use `]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>`.',
      expected:
        'Use `]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>`.',
    },
    {
      name: "fenced code",
      input:
        '```xml\n]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>\n```',
      expected:
        '```xml\n]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>\n```',
    },
    {
      name: "a standalone delimiter",
      input: "The literal ]<]minimax[>[ delimiter is not a tool call.",
      expected: "The literal ]<]minimax[>[ delimiter is not a tool call.",
    },
  ])("preserves $name", ({ input, expected }) => {
    expect(sanitizeAssistantVisibleTextWithProfile(input, "delivery")).toBe(expected);
  });

  it.each([
    { name: "inline code", example: "Example: `]<]minimax[>[</tool_call>`" },
    { name: "fenced code", example: "```xml\n]<]minimax[>[</tool_call>\n```" },
  ])(
    "ignores a false closer in $name and removes the complete internal envelope",
    ({ example }) => {
      const input = [
        "Before",
        "]<]minimax[>[<tool_call>",
        example,
        ']<]minimax[>[<invoke name="exec">PRIVATE_PAYLOAD</invoke>',
        "]<]minimax[>[</tool_call>",
        "After",
      ].join("\n");

      expect(sanitizeAssistantVisibleTextWithProfile(input, "delivery")).toBe("Before\n\nAfter");
    },
  );

  it("preserves encoded text in the internal-scaffolding profile", () => {
    expect(
      sanitizeAssistantVisibleTextWithProfile(
        'Before ]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">payload</invoke>]<]minimax[>[</tool_call> After',
        "internal-scaffolding",
      ),
    ).toBe(
      'Before ]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">payload</invoke>]<]minimax[>[</tool_call> After',
    );
  });

  it("stops searching after no closer exists for repeated incomplete openings", () => {
    const input = "]<]minimax[>[<tool_call>\n".repeat(256);
    const closeSource = "\\]?<\\]minimax\\[>\\[<\\/tool_call>";
    const exec = vi.spyOn(RegExp.prototype, "exec");

    let output: string;
    let closeSearches: number;
    try {
      output = stripMinimaxToolCallXml(input);
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

    expect(projection.append("Before ]<]mini")).toEqual({
      text: "Before ]<]mini",
      delta: "Before ]<]mini",
    });
    expect(
      projection.append('max[>[<tool_call>]<]minimax[>[<invoke name="exec">secret</invoke>'),
    ).toEqual({
      text: 'Before ]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">secret</invoke>',
      delta: 'max[>[<tool_call>]<]minimax[>[<invoke name="exec">secret</invoke>',
    });
    expect(projection.append("]<]minimax[>[</tool_call>After")).toEqual({
      text: "Before After",
      delta: null,
    });
    expect(projection.append(".")).toEqual({ text: "Before After.", delta: "." });
  });

  it("preserves a code example when it replaces previously filtered source", () => {
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
    projection.append(
      'Before ]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">secret</invoke>]<]minimax[>[</tool_call>After',
    );

    expect(
      projection.replace(
        'Use `]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>`.',
      ),
    ).toEqual({
      text: 'Use `]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>`.',
      delta: null,
    });
    expect(projection.append(" Kept.")).toEqual({
      text: 'Use `]<]minimax[>[<tool_call>]<]minimax[>[<invoke name="exec">example</invoke>]<]minimax[>[</tool_call>`. Kept.',
      delta: " Kept.",
    });
  });
});
