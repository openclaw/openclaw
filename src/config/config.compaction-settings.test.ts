import { expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";

it.each(["default", undefined] as const)(
  "preserves authored compaction settings with mode=%s",
  (mode) => {
    const compaction = {
      mode,
      thinkingLevel: "inherit",
      qualityGuard: { maxRetries: 99 },
    } as const;
    expect(
      applyCompactionDefaults({ agents: { defaults: { compaction } } }).agents?.defaults
        ?.compaction,
    ).toEqual({ ...compaction, mode: mode ?? "safeguard" });
  },
);
