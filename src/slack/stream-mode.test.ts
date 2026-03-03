import { describe, expect, it } from "vitest";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamingConfig,
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

describe("resolveSlackStreamingConfig", () => {
  it("defaults to partial mode with native streaming enabled", () => {
    expect(resolveSlackStreamingConfig({})).toEqual({
      mode: "partial",
      nativeStreaming: true,
      draftMode: "replace",
    });
  });

  it("maps legacy streamMode values to unified streaming modes", () => {
    expect(resolveSlackStreamingConfig({ streamMode: "append" })).toMatchObject({
      mode: "block",
      draftMode: "append",
    });
    expect(resolveSlackStreamingConfig({ streamMode: "status_final" })).toMatchObject({
      mode: "progress",
      draftMode: "status_final",
    });
  });

  it("maps legacy streaming booleans to unified mode and native streaming toggle", () => {
    expect(resolveSlackStreamingConfig({ streaming: false })).toEqual({
      mode: "off",
      nativeStreaming: false,
      draftMode: "replace",
    });
    expect(resolveSlackStreamingConfig({ streaming: true })).toEqual({
      mode: "partial",
      nativeStreaming: true,
      draftMode: "replace",
    });
  });

  it("accepts unified enum values directly", () => {
    expect(resolveSlackStreamingConfig({ streaming: "off" })).toEqual({
      mode: "off",
      nativeStreaming: true,
      draftMode: "replace",
    });
    expect(resolveSlackStreamingConfig({ streaming: "progress" })).toEqual({
      mode: "progress",
      nativeStreaming: true,
      draftMode: "status_final",
    });
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

  it("ignores incoming chunks that are empty after trimEnd", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "   \n\t  ",
      rendered: "hello",
      source: "hello",
    });
    expect(next).toEqual({ rendered: "hello", source: "hello", changed: false });
  });

  it("uses rendered prefix when incoming extends rendered text", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello world!!!",
      rendered: "hello world",
      source: "not-a-prefix",
    });
    expect(next).toEqual({
      rendered: "hello world!!!",
      source: "hello world!!!",
      changed: true,
    });
  });

  it("does not insert extra newline when rendered already ends with newline", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "second line",
      rendered: "first line\n",
      source: "first line",
    });
    expect(next).toEqual({
      rendered: "first line\nsecond line",
      source: "second line",
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

  it("handles zero and large update counts consistently", () => {
    // 0 is clamped to 1
    expect(buildStatusFinalPreviewText(0)).toBe("Status: thinking..");
    // 4 -> 4 % 3 = 1 -> two dots
    expect(buildStatusFinalPreviewText(4)).toBe("Status: thinking..");
    // 5 -> 5 % 3 = 2 -> three dots
    expect(buildStatusFinalPreviewText(5)).toBe("Status: thinking...");
  });
});
