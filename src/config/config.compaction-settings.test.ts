import { expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";
import { AgentDefaultsBaseSchema } from "./zod-schema.agent-defaults-base.js";

it.each([undefined, "local-summary", "deepseek/deepseek-flash"])(
  "preserves an explicit byte-summary opt-in without deriving it from model (%s)",
  (transcriptByteModel) => {
    const compaction = {
      mode: "default",
      model: "openrouter/anthropic/claude-sonnet-4-6",
      ...(transcriptByteModel === undefined ? {} : { transcriptByteModel }),
      thinkingLevel: "inherit",
      qualityGuard: { maxRetries: 99 },
    } as const;
    expect(
      applyCompactionDefaults({
        agents: { defaults: AgentDefaultsBaseSchema.parse({ compaction }) },
      }).agents?.defaults?.compaction,
    ).toEqual(compaction);
  },
);
