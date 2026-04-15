import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema maintenance extensions", () => {
  it("accepts valid maintenance extensions", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          resetArchiveRetention: "14d",
          maxDiskBytes: "500mb",
          highWaterBytes: "350mb",
        },
      }),
    ).not.toThrow();
  });

  it("accepts parentForkMaxTokens including 0 to disable the guard", () => {
    expect(() => SessionSchema.parse({ parentForkMaxTokens: 100_000 })).not.toThrow();
    expect(() => SessionSchema.parse({ parentForkMaxTokens: 0 })).not.toThrow();
  });

  it("rejects negative parentForkMaxTokens", () => {
    expect(() =>
      SessionSchema.parse({
        parentForkMaxTokens: -1,
      }),
    ).toThrow(/parentForkMaxTokens/i);
  });

  it("accepts disabling reset archive cleanup", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          resetArchiveRetention: false,
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid maintenance extension values", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          resetArchiveRetention: "never",
        },
      }),
    ).toThrow(/resetArchiveRetention|duration/i);

    expect(() =>
      SessionSchema.parse({
        maintenance: {
          maxDiskBytes: "big",
        },
      }),
    ).toThrow(/maxDiskBytes|size/i);
  });

  // --- transcriptRotateBytes ---

  it("accepts transcriptRotateBytes as a string", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          transcriptRotateBytes: "10mb",
        },
      }),
    ).not.toThrow();
  });

  it("accepts transcriptRotateBytes as a number", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          transcriptRotateBytes: 5_000_000,
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid transcriptRotateBytes string", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          transcriptRotateBytes: "big",
        },
      }),
    ).toThrow(/transcriptRotateBytes|size/i);
  });

  // --- transcriptMaxLines ---

  it("accepts transcriptMaxLines as a positive integer", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          transcriptMaxLines: 500,
        },
      }),
    ).not.toThrow();
  });

  it("rejects transcriptMaxLines of 0", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          transcriptMaxLines: 0,
        },
      }),
    ).toThrow();
  });

  it("rejects negative transcriptMaxLines", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          transcriptMaxLines: -1,
        },
      }),
    ).toThrow();
  });

  it("rejects non-integer transcriptMaxLines", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          transcriptMaxLines: 1.5,
        },
      }),
    ).toThrow();
  });

  it("accepts both transcriptRotateBytes and transcriptMaxLines together", () => {
    expect(() =>
      SessionSchema.parse({
        maintenance: {
          transcriptRotateBytes: "10mb",
          transcriptMaxLines: 500,
        },
      }),
    ).not.toThrow();
  });
});
