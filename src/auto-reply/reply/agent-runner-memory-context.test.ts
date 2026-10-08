import { expect, it } from "vitest";
import { resolveFollowupContextTokens } from "./agent-runner-memory-context.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

it.each([
  { name: "selected", selected: "small", declaresOptions: true, expected: 200_000 },
  { name: "default", selected: undefined, declaresOptions: true, expected: 200_000 },
  { name: "scalar", selected: undefined, declaresOptions: false, expected: 1_000_000 },
])(
  "uses the $name catalog window for fixed-window memory budgets",
  async ({ selected, declaresOptions, expected }) => {
    const followupRun = createTestFollowupRun({
      provider: "anthropic",
      model: "claude-opus-5",
      thinkingCatalog: [
        {
          provider: "anthropic",
          id: "claude-opus-5",
          contextWindow: 1_000_000,
          ...(declaresOptions
            ? {
                contextWindows: [{ id: "small", label: "Small", contextWindow: 200_000 }],
                contextWindowDefault: "small",
              }
            : {}),
        },
      ],
    });
    expect(
      await resolveFollowupContextTokens(
        {
          cfg: {},
          followupRun,
          defaultModel: "anthropic/claude-opus-5",
          sessionEntry: { sessionId: "memory-context", updatedAt: 0, contextWindow: selected },
        },
        "openclaw",
      ),
    ).toBe(expected);
  },
);
