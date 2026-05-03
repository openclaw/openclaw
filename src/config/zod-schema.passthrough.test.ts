import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema preserves unknown top-level keys (.passthrough at root)", () => {
  // The root schema previously used .strict(), which silently dropped
  // unknown top-level keys on parse. When a tool reads, mutates, and writes
  // the config back, that round-trip permanently lost any field the tool
  // didn't know about (deprecated keys, future-flag stubs, third-party
  // extensions). One downstream user observed 78 .clobbered.* recovery
  // files accumulated from this exact pattern.
  //
  // Switching the ROOT validator to .passthrough() lets unknown top-level
  // keys survive as inert data. All 125 nested .strict() validators are
  // unchanged - section-level enforcement is preserved.
  it("preserves an unknown top-level key on round-trip parse", () => {
    const input: Record<string, unknown> = {
      $schema: "https://openclaw.ai/config.json",
      unknownLegacyField: "preserve me",
    };

    const result = OpenClawSchema.safeParse(input);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).unknownLegacyField).toBe("preserve me");
    }
  });
});
