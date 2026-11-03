import { afterEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { evaluateEntryRequirementsForCurrentPlatform as evaluateEntry } from "./entry-status.js";

type Params = Parameters<typeof evaluateEntry>[0];
const evaluate = (entry: Params["entry"], overrides: Partial<Params> = {}) =>
  evaluateEntry({
    always: false,
    entry,
    hasLocalBin: () => false,
    isEnvSatisfied: () => false,
    isConfigSatisfied: () => false,
    ...overrides,
  });
afterEach(() => vi.restoreAllMocks());

it("combines metadata presentation with local binary availability", () => {
  const result = evaluate(
    {
      metadata: { emoji: "🦀", homepage: " https://a.test ", requires: { bins: ["bun"] } },
      frontmatter: { emoji: "🙂", homepage: "https://b.test" },
    },
    { hasLocalBin: (bin) => bin === "bun" },
  );
  expect(result).toMatchObject({
    emoji: "🦀",
    homepage: "https://a.test",
    missing: { bins: [] },
  });
});

it("defaults OS evaluation to process.platform", () => {
  mockProcessPlatform("darwin");
  expect(evaluate({ metadata: { os: ["darwin"] } })).toMatchObject({
    requirementsSatisfied: true,
    missing: { os: [] },
  });
});

it.each([
  [undefined, { website: " https://a ", emoji: "🙂" }, "🙂", "https://a"],
  [{ emoji: "", homepage: " " }, { emoji: "🙂", homepage: "https://b" }, undefined, undefined],
  [undefined, { emoji: " ", url: " https://a " }, " ", "https://a"],
  [undefined, { homepage: " ", website: "https://b", url: "https://a" }, undefined, undefined],
] as const)("preserves presentation precedence (%#)", (metadata, frontmatter, emoji, homepage) => {
  const result = evaluate({ metadata, frontmatter });
  expect({ emoji: result.emoji, homepage: result.homepage }).toEqual({ emoji, homepage });
});
