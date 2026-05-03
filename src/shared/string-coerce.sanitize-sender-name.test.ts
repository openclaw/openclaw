import { describe, expect, it } from "vitest";
import { sanitizeSenderNameForModel } from "./string-coerce.js";

describe("sanitizeSenderNameForModel", () => {
  it("passes through clean ASCII names unchanged", () => {
    expect(sanitizeSenderNameForModel("Alice")).toBe("Alice");
    expect(sanitizeSenderNameForModel("bob-42")).toBe("bob-42");
    expect(sanitizeSenderNameForModel("user_name")).toBe("user_name");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeSenderNameForModel("John Doe")).toBe("John_Doe");
  });

  it("replaces accented and CJK characters", () => {
    expect(sanitizeSenderNameForModel("José García")).toBe("Jos_Garc_a");
    expect(sanitizeSenderNameForModel("张三")).toBe(undefined);
    expect(sanitizeSenderNameForModel("田中太郎")).toBe(undefined);
  });

  it("handles mixed ASCII and non-ASCII", () => {
    expect(sanitizeSenderNameForModel("Alice 张三")).toBe("Alice");
  });

  it("replaces emoji", () => {
    expect(sanitizeSenderNameForModel("Bob 🚀")).toBe("Bob");
  });

  it("collapses consecutive underscores", () => {
    expect(sanitizeSenderNameForModel("a   b")).toBe("a_b");
    expect(sanitizeSenderNameForModel("a!!!b")).toBe("a_b");
  });

  it("trims leading and trailing underscores", () => {
    expect(sanitizeSenderNameForModel(" Alice ")).toBe("Alice");
    expect(sanitizeSenderNameForModel("!!!Alice!!!")).toBe("Alice");
  });

  it("truncates to 64 characters", () => {
    const long = "A".repeat(100);
    const result = sanitizeSenderNameForModel(long);
    expect(result).toBe("A".repeat(64));
  });

  it("returns undefined for null, undefined, and empty string", () => {
    expect(sanitizeSenderNameForModel(null)).toBeUndefined();
    expect(sanitizeSenderNameForModel(undefined)).toBeUndefined();
    expect(sanitizeSenderNameForModel("")).toBeUndefined();
  });

  it("returns undefined when all characters are non-conforming", () => {
    expect(sanitizeSenderNameForModel("🎉🎊🎈")).toBeUndefined();
    expect(sanitizeSenderNameForModel("   ")).toBeUndefined();
  });
});
