// Covers once-per-process deprecation warnings for streaming config fallbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStreamingDeprecationWarningsForTest } from "./streaming-flat-key-deprecation.js";
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockCoalesce,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingChunkMode,
  resolveChannelStreamingPreviewChunk,
} from "./streaming.js";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => loggerMocks),
}));

describe("streaming config fallback deprecation warnings", () => {
  beforeEach(() => {
    resetStreamingDeprecationWarningsForTest();
    loggerMocks.warn.mockClear();
  });

  afterEach(() => {
    resetStreamingDeprecationWarningsForTest();
  });

  it("warns once per key when the flat fallback is actually used", () => {
    expect(resolveChannelStreamingChunkMode({ chunkMode: "newline" })).toBe("newline");
    expect(resolveChannelStreamingChunkMode({ chunkMode: "newline" })).toBe("newline");
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain('"chunkMode"');
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain("streaming.chunkMode");

    expect(resolveChannelStreamingBlockEnabled({ blockStreaming: true })).toBe(true);
    expect(resolveChannelStreamingBlockCoalesce({ blockStreamingCoalesce: { idleMs: 5 } })).toEqual(
      { idleMs: 5 },
    );
    expect(resolveChannelStreamingPreviewChunk({ draftChunk: { minChars: 10 } })).toEqual({
      minChars: 10,
    });
    expect(loggerMocks.warn).toHaveBeenCalledTimes(4);
  });

  it("stays silent when nested config wins or no flat key is set", () => {
    expect(
      resolveChannelStreamingChunkMode({
        streaming: { chunkMode: "length" },
        chunkMode: "newline",
      }),
    ).toBe("length");
    expect(resolveChannelStreamingBlockEnabled({ streaming: { block: { enabled: false } } })).toBe(
      false,
    );
    expect(resolveChannelStreamingBlockCoalesce({})).toBeUndefined();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it("warns once when the scalar boolean fallback is used", () => {
    expect(resolveChannelPreviewStreamMode({ streaming: true }, "off")).toBe("partial");
    expect(resolveChannelPreviewStreamMode({ streaming: false }, "partial")).toBe("off");
    expect(resolveChannelPreviewStreamMode({ streaming: true }, "off")).toBe("partial");

    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain("streaming.mode");
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain('true with "partial"');
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain('false with "off"');
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain("after the next release train");
  });

  it("warns once when the scalar mode-string fallback is used", () => {
    expect(resolveChannelPreviewStreamMode({ streaming: "progress" }, "off")).toBe("progress");
    expect(resolveChannelPreviewStreamMode({ streaming: "block" }, "partial")).toBe("block");

    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain("streaming.mode");
  });

  it("tracks scalar and flat fallback warnings independently", () => {
    expect(resolveChannelPreviewStreamMode({ streaming: "partial" }, "off")).toBe("partial");
    expect(resolveChannelStreamingChunkMode({ chunkMode: "newline" })).toBe("newline");
    expect(resolveChannelPreviewStreamMode({ streaming: "partial" }, "off")).toBe("partial");
    expect(resolveChannelStreamingChunkMode({ chunkMode: "newline" })).toBe("newline");

    expect(loggerMocks.warn).toHaveBeenCalledTimes(2);
    expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain("streaming.mode");
    expect(loggerMocks.warn.mock.calls[1]?.[0]).toContain('"chunkMode"');
  });

  it("stays silent for nested streaming config and absent streaming", () => {
    expect(resolveChannelPreviewStreamMode({ streaming: { mode: "progress" } }, "off")).toBe(
      "progress",
    );
    expect(resolveChannelPreviewStreamMode({}, "partial")).toBe("partial");
    expect(resolveChannelPreviewStreamMode(undefined, "off")).toBe("off");

    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });
});
