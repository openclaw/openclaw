import { expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";

it("preserves authored compaction settings", () => {
  const compaction = {
    mode: "default",
    thinkingLevel: "inherit",
    qualityGuard: { maxRetries: 99 },
  } as const;
  expect(
    applyCompactionDefaults({ agents: { defaults: { compaction } } }).agents?.defaults?.compaction,
  ).toEqual(compaction);
});
