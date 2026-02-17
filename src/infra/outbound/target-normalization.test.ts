import { describe, expect, it, vi } from "vitest";
import { normalizeTargetForProvider } from "./target-normalization.js";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
  normalizeChannelId: (value: string) => value,
}));

describe("normalizeTargetForProvider", () => {
  it("returns string when plugin normalizeTarget returns a string", () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: { normalizeTarget: () => "c2c:ABC123" },
    });
    expect(normalizeTargetForProvider("test", "ABC123")).toBe("c2c:ABC123");
  });

  it("unwraps { to } object returned by a plugin normalizeTarget", () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: { normalizeTarget: () => ({ ok: true, to: "c2c:ABC123" }) },
    });
    expect(normalizeTargetForProvider("test", "ABC123")).toBe("c2c:ABC123");
  });

  it("falls back to raw when plugin returns undefined", () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: { normalizeTarget: () => undefined },
    });
    expect(normalizeTargetForProvider("test", "ABC123")).toBe("ABC123");
  });

  it("falls back to raw when no plugin exists", () => {
    mocks.getChannelPlugin.mockReturnValue(undefined);
    expect(normalizeTargetForProvider("test", "ABC123")).toBe("ABC123");
  });
});
