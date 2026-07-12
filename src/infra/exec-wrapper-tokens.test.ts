// Tests for executable token normalization.
import { describe, expect, it } from "vitest";
import { basenameLower, normalizeExecutableToken } from "./exec-wrapper-tokens.js";

describe("basenameLower", () => {
  it("returns lowercase basename", () => {
    expect(basenameLower("/usr/bin/Node")).toBe("node");
  });
  it("returns basename without path", () => {
    expect(basenameLower("node")).toBe("node");
  });
  it("handles Windows path", () => {
    expect(basenameLower("C:\\Program Files\\Node\\node.exe")).toBe("node.exe");
  });
  it("returns empty for root path", () => {
    expect(basenameLower("/")).toBe("");
  });
});

describe("normalizeExecutableToken", () => {
  it("returns lowercase basename", () => {
    expect(normalizeExecutableToken("/usr/bin/Node")).toBe("node");
  });
  it("strips .exe suffix", () => {
    expect(normalizeExecutableToken("node.exe")).toBe("node");
  });
  it("strips .cmd suffix", () => {
    expect(normalizeExecutableToken("script.cmd")).toBe("script");
  });
  it("preserves non-executable extension", () => {
    expect(normalizeExecutableToken("config.json")).toBe("config.json");
  });
  it("strips .bat suffix", () => {
    expect(normalizeExecutableToken("script.bat")).toBe("script");
  });
  it("strips .com suffix", () => {
    expect(normalizeExecutableToken("command.com")).toBe("command");
  });
  it("handles full Windows path", () => {
    expect(normalizeExecutableToken("C:\\Program Files\\node.exe")).toBe("node");
  });
});
