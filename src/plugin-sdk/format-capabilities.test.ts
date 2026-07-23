import { describe, expect, expectTypeOf, it } from "vitest";
import type { FormatCapabilityProfile } from "./text-chunking.js";

describe("FormatCapabilityProfile", () => {
  it("preserves literal inference with satisfies", () => {
    const profile = {
      mechanism: "ranges",
      constructs: {
        bold: "native",
        italic: "native",
        underline: "strip",
        strikethrough: "native",
        spoiler: "fallback",
        codeInline: "native",
        codeBlock: "native",
        codeLanguage: "strip",
        linkLabel: "fallback",
        heading: "fallback",
        bulletList: "fallback",
        orderedList: "fallback",
        taskList: "fallback",
        table: "strip",
        blockquote: "fallback",
        image: "strip",
        mention: "native",
      },
      chunk: { limit: 2_048, unit: "bytes", hardCap: 65_536 },
    } satisfies FormatCapabilityProfile;

    expectTypeOf(profile.mechanism).toEqualTypeOf<"ranges">();
    expectTypeOf(profile.constructs.underline).toEqualTypeOf<"strip">();
    expectTypeOf(profile.chunk.unit).toEqualTypeOf<"bytes">();
    expect(profile.chunk.hardCap).toBe(65_536);
  });
});
