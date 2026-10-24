import { afterEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "./entry-status.js";

type EntryParams = Parameters<typeof evaluateEntryRequirementsForCurrentPlatform>[0];
type Requirements = ReturnType<typeof evaluate>["required"];
function requirements(overrides: Partial<Requirements> = {}) {
  return { bins: [], anyBins: [], env: [], config: [], os: [], ...overrides };
}

function evaluate(overrides: Partial<EntryParams>) {
  return evaluateEntryRequirementsForCurrentPlatform({
    always: false,
    entry: {},
    hasLocalBin: () => false,
    isEnvSatisfied: () => false,
    isConfigSatisfied: () => false,
    ...overrides,
  });
}
const fm = (frontmatter: NonNullable<EntryParams["entry"]["frontmatter"]>) => ({ frontmatter });

afterEach(() => vi.restoreAllMocks());

it("combines metadata presentation fields with evaluated requirements", () => {
  mockProcessPlatform("linux");

  const required = requirements({
    bins: ["bun"],
    anyBins: ["ffmpeg", "sox"],
    env: ["OPENCLAW_TOKEN"],
    config: ["gateway.bind"],
    os: ["darwin"],
  });
  const { os, ...requires } = structuredClone(required);
  const result = evaluate({
    entry: {
      metadata: { emoji: "🦀", homepage: " https://openclaw.ai ", requires, os },
      frontmatter: { emoji: "🙂", homepage: "https://docs.openclaw.ai" },
    },
    hasLocalBin: (bin) => bin === "bun",
    remote: { hasAnyBin: (bins) => bins.includes("sox") },
    isConfigSatisfied: (path) => path === "gateway.bind",
  });

  expect(result).toEqual({
    emoji: "🦀",
    homepage: "https://openclaw.ai",
    required,
    missing: requirements({ env: ["OPENCLAW_TOKEN"], os: ["darwin"] }),
    requirementsSatisfied: false,
    configChecks: [{ path: "gateway.bind", satisfied: true }],
  });
});

it("evaluates OS requirements against process.platform", () => {
  mockProcessPlatform("darwin");

  expect(evaluate({ entry: { metadata: { os: ["darwin"] } } })).toMatchObject({
    requirementsSatisfied: true,
    missing: { os: [] },
  });
});

it("combines frontmatter presentation with always-on requirements", () => {
  mockProcessPlatform("linux");

  const result = evaluate({
    always: true,
    entry: {
      metadata: { requires: { bins: ["missing-bin"] } },
      frontmatter: { website: " https://docs.openclaw.ai ", emoji: "🙂" },
    },
  });

  expect(result).toEqual({
    emoji: "🙂",
    homepage: "https://docs.openclaw.ai",
    required: requirements({ bins: ["missing-bin"] }),
    missing: requirements(),
    requirementsSatisfied: true,
    configChecks: [],
  });
});

it.each<[string, EntryParams["entry"], { emoji?: string; homepage?: string }]>([
  [
    "blank metadata wins",
    {
      metadata: { emoji: "", homepage: "   " },
      ...fm({ emoji: "🙂", homepage: "https://example.com" }),
    },
    {},
  ],
  [
    "trims fallback URL",
    fm({ emoji: " ", url: " https://openclaw.ai/install " }),
    { emoji: " ", homepage: "https://openclaw.ai/install" },
  ],
  [
    "blank homepage wins",
    fm({ homepage: " ", website: "https://docs.openclaw.ai", url: "https://openclaw.ai/install" }),
    {},
  ],
])("preserves presentation precedence: %s", (_name, entry, expected) => {
  expect(evaluate({ entry })).toStrictEqual({
    ...expected,
    required: requirements(),
    missing: requirements(),
    requirementsSatisfied: true,
    configChecks: [],
  });
});
