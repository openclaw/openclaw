import { describe, expect, it } from "vitest";
import { stripAssistantInternalScaffolding } from "./assistant-internal-scaffolding.js";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";

describe("batch internal scaffolding", () => {
  it("preserves literal control tags while never recovering private internal text", () => {
    expect(stripAssistantInternalScaffolding("Use `<internal>literal</internal>`.")).toBe(
      "Use `<internal>literal</internal>`.",
    );
    expect(stripAssistantInternalScaffolding("<internal>private unfinished")).toBe("");
    expect(stripAssistantInternalScaffolding("<think>visible unfinished")).toBe(
      "visible unfinished",
    );
  });

  it.each([
    "!<tool_call/>[example `<parameter>x</parameter>`][id]\n\n[id]: /image",
    "Before <|assistant|> <relevant-memories>private</relevant-memories> after",
    'Use `[TOOL_CALL] tool => "read" args => {} [/TOOL_CALL]` literally.\n<internal>private</internal>',
    "> ```\n> <internal>literal</internal>\n> ```\n<final>Answer</final>\n",
  ])("matches the shared server profile at every prefix: %j", (text) => {
    const filters = assistantVisibleTextFilters("internal-scaffolding");
    for (let end = 0; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      const expected = filters.reduce((value, filter) => filter.transform(value), prefix);
      expect(stripAssistantInternalScaffolding(prefix)).toBe(expected);
    }
  });
});
