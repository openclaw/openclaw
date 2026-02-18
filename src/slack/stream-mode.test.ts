import { describe, expect, it } from "vitest";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamMode,
} from "./stream-mode.js";

describe("resolveSlackStreamMode", () => {
  it("defaults to replace", () => {
    expect(resolveSlackStreamMode(undefined)).toBe("replace");
    expect(resolveSlackStreamMode("")).toBe("replace");
    expect(resolveSlackStreamMode("unknown")).toBe("replace");
  });

  it("accepts valid modes", () => {
    expect(resolveSlackStreamMode("replace")).toBe("replace");
    expect(resolveSlackStreamMode("status_final")).toBe("status_final");
    expect(resolveSlackStreamMode("append")).toBe("append");
  });
});

describe("applyAppendOnlyStreamUpdate", () => {
  it("starts with first incoming text", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello",
      rendered: "",
      source: "",
    });
    expect(next).toEqual({ rendered: "hello", source: "hello", changed: true });
  });

  it("uses cumulative incoming text when it extends prior source", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello world",
      rendered: "hello",
      source: "hello",
    });
    expect(next).toEqual({
      rendered: "hello world",
      source: "hello world",
      changed: true,
    });
  });

  it("ignores regressive shorter incoming text", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello",
      rendered: "hello world",
      source: "hello world",
    });
    expect(next).toEqual({
      rendered: "hello world",
      source: "hello world",
      changed: false,
    });
  });

  it("appends non-prefix incoming chunks", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "next chunk",
      rendered: "hello world",
      source: "hello world",
    });
    expect(next).toEqual({
      rendered: "hello world\nnext chunk",
      source: "next chunk",
      changed: true,
    });
  });
});

describe("buildStatusFinalPreviewText", () => {
  it("cycles status dots", () => {
    expect(buildStatusFinalPreviewText(1)).toBe("Status: thinking..");
    expect(buildStatusFinalPreviewText(2)).toBe("Status: thinking...");
    expect(buildStatusFinalPreviewText(3)).toBe("Status: thinking.");
  });
});
