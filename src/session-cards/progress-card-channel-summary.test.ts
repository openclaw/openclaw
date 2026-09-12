import { describe, expect, it } from "vitest";
import { projectProgressCardChannelUpdate } from "./progress-card-channel-summary.js";

describe("projectProgressCardChannelUpdate", () => {
  it.each([
    {
      name: "checklist",
      input: { plan: [{ step: "Ship", status: "completed" }] },
      expected: {
        steps: [{ step: "Ship", status: "completed" }],
        explanation: "1/1 complete",
      },
    },
    {
      name: "markdown-only",
      input: { markdown: "Checking recent plan submissions and the tool's selection guidance." },
      expected: {
        steps: [],
        explanation: "Checking recent plan submissions and the tool's selection guidance.",
      },
    },
    {
      name: "formatted note with renderer markup",
      input: {
        markdown:
          '<progress aria-label="Checks, 1/2" value="1" max="2"></progress>\n\n**Checking** [results](https://example.com).<br>Next step.<script>ignored()</script>',
      },
      expected: { steps: [], explanation: "Checking results. Next step." },
    },
    {
      name: "markup without visible text",
      input: { markdown: '<progress value="1" max="2"></progress>' },
      expected: { steps: [], explanation: "Progress updated" },
    },
    {
      name: "checklist with a note",
      input: {
        markdown: "Checking the next task.",
        plan: [{ step: "Ship", status: "completed" }],
      },
      expected: {
        steps: [{ step: "Ship", status: "completed" }],
        explanation: "1/1 complete",
      },
    },
    { name: "clear", input: {}, expected: { steps: [] } },
    { name: "invalid array", input: [], expected: undefined },
  ])("projects normalized $name input for every runtime producer", ({ input, expected }) => {
    expect(projectProgressCardChannelUpdate(input)).toEqual(expected);
  });
});
