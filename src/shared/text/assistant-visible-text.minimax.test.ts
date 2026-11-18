import { describe, expect, it, vi } from "vitest";
import {
  assistantVisibleTextFilters,
  minimaxToolCallTextFilter,
  sanitizeAssistantVisibleTextWithProfile,
} from "./assistant-visible-text.js";
import { createTextProjection } from "./text-projection.js";

describe("MiniMax tool envelopes", () => {
  it.each(["delivery", "final-answer-delivery"] as const)(
    "recovers a terminal invocation with an unclosed JSON quote for %s",
    (profile) => {
      const input =
        'Ready.\n<minimax:tool_call><invoke name="exec">{"note":"TAIL_SENTINEL}</invoke></minimax:tool_call>\nDone.';
      expect(sanitizeAssistantVisibleTextWithProfile(input, profile)).toBe("Ready.\n\nDone.");
      expect(sanitizeAssistantVisibleTextWithProfile(input, profile, true)).toBe("Ready.");
    },
  );

  it("waits for the real closer while quoted arguments are still streaming", () => {
    const projection = createTextProjection(
      assistantVisibleTextFilters("final-answer-delivery", true),
    );
    const prefix =
      'Ready.\n<minimax:tool_call><invoke name="exec">{"command":"printf </invoke>","note":"TAIL_SENTINEL';
    expect(projection.append(prefix).text).toBe("Ready.");
    expect(projection.append('"}</invoke></minimax:tool_call>\nDone.').text).toBe(
      "Ready.\n\nDone.",
    );
  });

  it.each([
    [
      "a quoted closing tag in JSON arguments",
      JSON.stringify({ command: 'printf "</invoke>"', note: "TAIL_SENTINEL" }),
    ],
    ["a closing tag in inline code", "Write `</invoke>` followed by TAIL_SENTINEL."],
    ["an apostrophe in ordinary text", "Don't display TAIL_SENTINEL."],
  ])("removes the whole invocation with %s", (_name, payload) => {
    const input = `Ready.\n<minimax:tool_call><invoke name="exec">${payload}</invoke></minimax:tool_call>\nDone.`;
    const expected = "Ready.\n\nDone.";
    expect(sanitizeAssistantVisibleTextWithProfile(input, "final-answer-delivery")).toBe(expected);

    const projection = createTextProjection(
      assistantVisibleTextFilters("final-answer-delivery", true),
    );
    for (let offset = 0; offset < input.length; offset += 4) {
      projection.append(input.slice(offset, offset + 4));
    }
    expect(projection.text).toBe(expected);
  });

  it("does not let a JSON backtick mask the invocation closer", () => {
    const payload = JSON.stringify({ command: "printf `", note: "TAIL_SENTINEL" });
    const input = `Ready.\n<minimax:tool_call><invoke name="exec">${payload}</invoke>\nAfter \`done\`.`;
    for (const streaming of [false, true]) {
      expect(minimaxToolCallTextFilter(streaming).transform(input)).toBe("Ready.\n\nAfter `done`.");
    }
  });

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
      output = minimaxToolCallTextFilter().transform(input);
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
