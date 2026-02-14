import { describe, it, expect } from "vitest";
import {
  formatModelLoadingMessage,
  formatModelLoadedMessage,
  formatFirstTokenMessage,
} from "./tui-model-loading.js";

describe("formatModelLoadingMessage", () => {
  it("includes model name and timing hint", () => {
    const result = formatModelLoadingMessage("gemma3:4b");
    expect(result).toContain("gemma3:4b");
    expect(result).toContain("🌱");
    expect(result).toContain("10-30s");
  });
});

describe("formatModelLoadedMessage", () => {
  it("formats duration in seconds", () => {
    const result = formatModelLoadedMessage("gemma3:4b", 12300);
    expect(result).toBe("🌿 gemma3:4b loaded in 12.3s — ready to chat!");
  });

  it("handles sub-second loads", () => {
    expect(formatModelLoadedMessage("tiny", 500)).toContain("0.5s");
  });
});

describe("formatFirstTokenMessage", () => {
  it("formats TTFT", () => {
    expect(formatFirstTokenMessage(1200)).toBe("⚡ First token in 1.2s");
  });

  it("handles fast tokens", () => {
    expect(formatFirstTokenMessage(50)).toBe("⚡ First token in 0.1s");
  });
});
