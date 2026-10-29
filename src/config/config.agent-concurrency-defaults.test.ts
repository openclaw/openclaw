import { expect, it } from "vitest";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "./agent-limits.js";

it("clamps invalid agent concurrency limits to at least one", () => {
  const config = { agents: { defaults: { maxConcurrent: 0, subagents: { maxConcurrent: -3 } } } };
  expect(resolveAgentMaxConcurrent(config)).toBe(1);
  expect(resolveSubagentMaxConcurrent(config)).toBe(1);
});
