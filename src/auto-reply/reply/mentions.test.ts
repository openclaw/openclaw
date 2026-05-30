import { describe, expect, it } from "vitest";
import { stripStructuralPrefixes } from "./mentions.js";

describe("stripStructuralPrefixes", () => {
  it("returns empty string for undefined input at runtime", () => {
    expect(stripStructuralPrefixes(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips sender prefix labels", () => {
    expect(stripStructuralPrefixes("John: hello")).toBe("hello");
  });

  it("passes through plain text", () => {
    expect(stripStructuralPrefixes("just a message")).toBe("just a message");
  });

  it("preserves bracketed values inside command arguments", () => {
    expect(stripStructuralPrefixes('/config set messages.responsePrefix="[cu]"')).toBe(
      '/config set messages.responsePrefix="[cu]"',
    );
    expect(stripStructuralPrefixes('/config set messages.responsePrefix="pre[cu]post"')).toBe(
      '/config set messages.responsePrefix="pre[cu]post"',
    );
  });

  it("strips leading bracketed structural prefixes", () => {
    expect(stripStructuralPrefixes("[Fri 2026-05-29 00:00 PDT] /status")).toBe("/status");
  });

  it("flattens multiline soft reset commands before downstream parsing", () => {
    expect(stripStructuralPrefixes("/reset soft\nre-read persona files")).toBe(
      "/reset soft re-read persona files",
    );
    expect(stripStructuralPrefixes("/reset \nsoft")).toBe("/reset soft");
  });
});
