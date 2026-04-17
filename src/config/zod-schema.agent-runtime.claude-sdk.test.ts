import { describe, expect, it } from "vitest";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

// Phase 0 contract test for the `agents.runtime` flag migration
// (see plans/proud-roaming-lollipop.md).
//
// The `claude-sdk` runtime variant is additive: it must parse without
// regressing the existing `embedded` and `acp` variants, and it must stay
// off by default (omitting `runtime` entirely remains the legacy code path
// in `agent-command.ts`).

const BASE_AGENT_ENTRY = { id: "test-agent" } as const;

describe("AgentEntrySchema runtime variants", () => {
  it("accepts agent entries with no runtime block (legacy default path)", () => {
    const parsed = AgentEntrySchema.parse({ ...BASE_AGENT_ENTRY });
    expect(parsed.runtime).toBeUndefined();
  });

  it("accepts the existing embedded runtime variant", () => {
    const parsed = AgentEntrySchema.parse({
      ...BASE_AGENT_ENTRY,
      runtime: { type: "embedded" },
    });
    expect(parsed.runtime?.type).toBe("embedded");
  });

  it("accepts the existing acp runtime variant", () => {
    const parsed = AgentEntrySchema.parse({
      ...BASE_AGENT_ENTRY,
      runtime: { type: "acp", acp: { agent: "codex" } },
    });
    expect(parsed.runtime?.type).toBe("acp");
  });

  it("accepts the new claude-sdk runtime variant with no extra config", () => {
    const parsed = AgentEntrySchema.parse({
      ...BASE_AGENT_ENTRY,
      runtime: { type: "claude-sdk" },
    });
    expect(parsed.runtime?.type).toBe("claude-sdk");
  });

  it("accepts the new claude-sdk runtime variant with claudeSdk overrides", () => {
    const parsed = AgentEntrySchema.parse({
      ...BASE_AGENT_ENTRY,
      runtime: {
        type: "claude-sdk",
        claudeSdk: { model: "claude-opus-4-6", maxTurns: 20 },
      },
    });
    // Narrow for type-safe access to the discriminated union.
    if (parsed.runtime?.type === "claude-sdk") {
      expect(parsed.runtime.claudeSdk?.model).toBe("claude-opus-4-6");
      expect(parsed.runtime.claudeSdk?.maxTurns).toBe(20);
    } else {
      throw new Error("expected claude-sdk runtime variant");
    }
  });

  it("rejects unknown runtime types", () => {
    expect(() =>
      AgentEntrySchema.parse({
        ...BASE_AGENT_ENTRY,
        runtime: { type: "not-a-real-runtime" },
      }),
    ).toThrow();
  });

  it("rejects positive-integer violations on claudeSdk.maxTurns", () => {
    expect(() =>
      AgentEntrySchema.parse({
        ...BASE_AGENT_ENTRY,
        runtime: { type: "claude-sdk", claudeSdk: { maxTurns: 0 } },
      }),
    ).toThrow();
  });

  it("rejects unknown fields inside claudeSdk (strict object)", () => {
    expect(() =>
      AgentEntrySchema.parse({
        ...BASE_AGENT_ENTRY,
        runtime: {
          type: "claude-sdk",
          claudeSdk: { model: "claude-opus-4-6", unexpected: true },
        },
      }),
    ).toThrow();
  });
});
