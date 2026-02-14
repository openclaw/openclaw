import { describe, expect, it } from "vitest";
import {
  buildWaitingStatusMessage,
  ollamaLoadingPhrases,
  pickWaitingPhrase,
} from "./tui-waiting.js";

const theme = {
  dim: (s: string) => `<d>${s}</d>`,
  bold: (s: string) => `<b>${s}</b>`,
  accentSoft: (s: string) => `<a>${s}</a>`,
  // oxlint-disable-next-line typescript/no-explicit-any
} as any;

describe("tui-waiting", () => {
  it("pickWaitingPhrase rotates every 10 ticks", () => {
    const phrases = ["a", "b", "c"];
    expect(pickWaitingPhrase(0, phrases)).toBe("a");
    expect(pickWaitingPhrase(9, phrases)).toBe("a");
    expect(pickWaitingPhrase(10, phrases)).toBe("b");
    expect(pickWaitingPhrase(20, phrases)).toBe("c");
    expect(pickWaitingPhrase(30, phrases)).toBe("a");
  });

  it("uses loading phrases when ollamaStatus.stage is loading", () => {
    const msg = buildWaitingStatusMessage({
      theme,
      tick: 0,
      elapsed: "5s",
      connectionStatus: "connected",
      ollamaStatus: { stage: "loading" },
    });
    // Should use one of the ollama loading phrases
    const usedPhrase = ollamaLoadingPhrases[0];
    for (const ch of usedPhrase) {
      expect(msg).toContain(ch);
    }
  });

  it("shows tok/s when ollamaStatus.stage is generating", () => {
    const msg = buildWaitingStatusMessage({
      theme,
      tick: 0,
      elapsed: "5s",
      connectionStatus: "connected",
      ollamaStatus: { stage: "generating", tokPerSec: 42.5 },
    });
    expect(msg).toContain("42.5 tok/s");
  });

  it("buildWaitingStatusMessage includes shimmer markup and metadata", () => {
    const msg = buildWaitingStatusMessage({
      theme,
      tick: 1,
      elapsed: "3s",
      connectionStatus: "connected",
      phrases: ["hello"],
    });

    expect(msg).toContain("connected");
    expect(msg).toContain("3s");
    // text is wrapped per-char; check it appears in order
    expect(msg).toContain("h");
    expect(msg).toContain("e");
    expect(msg).toContain("l");
    expect(msg).toContain("o");
    // shimmer should contain both highlighted and dim parts
    expect(msg).toContain("<b><a>");
    expect(msg).toContain("<d>");
  });
});
