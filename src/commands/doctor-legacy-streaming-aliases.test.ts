import { describe, expect, it } from "vitest";
import { normalizeStreamingAliasesForProvider } from "./doctor-legacy-streaming-aliases.js";

describe("normalizeStreamingAliasesForProvider", () => {
  it("normalizes discord boolean streaming aliases to enum values", () => {
    const result = normalizeStreamingAliasesForProvider({
      provider: "discord",
      entry: { streaming: true },
      pathPrefix: "channels.discord",
    });

    expect(result.entry).toEqual({ streaming: "partial" });
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      "Normalized channels.discord.streaming boolean → enum (partial).",
    ]);
  });

  it("moves telegram streamMode into streaming", () => {
    const result = normalizeStreamingAliasesForProvider({
      provider: "telegram",
      entry: { streamMode: "block" },
      pathPrefix: "channels.telegram",
    });

    expect(result.entry).toEqual({ streaming: "block" });
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      "Moved channels.telegram.streamMode → channels.telegram.streaming (block).",
    ]);
  });

  it("normalizes slack legacy streaming keys to streaming and nativeStreaming", () => {
    const result = normalizeStreamingAliasesForProvider({
      provider: "slack",
      entry: { streaming: false, streamMode: "status_final" },
      pathPrefix: "channels.slack",
    });

    expect(result.entry).toEqual({
      streaming: "progress",
      nativeStreaming: false,
    });
    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      "Moved channels.slack.streamMode → channels.slack.streaming (progress).",
      "Moved channels.slack.streaming (boolean) → channels.slack.nativeStreaming (false).",
    ]);
  });
});
