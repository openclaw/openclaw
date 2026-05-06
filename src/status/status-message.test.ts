import { describe, expect, it } from "vitest";
import { formatFastModeLabel } from "./status-labels.js";
import { buildStatusMessage } from "./status-message.js";

describe("formatFastModeLabel", () => {
  it("shows fast mode when enabled", () => {
    expect(formatFastModeLabel(true)).toBe("Fast");
  });

  it("hides fast mode when disabled", () => {
    expect(formatFastModeLabel(false)).toBeNull();
  });
});

describe("buildStatusMessage", () => {
  it("includes channel-owned status lines below the session line", () => {
    const text = buildStatusMessage({
      config: {},
      agent: { model: "openai/gpt-5.4" },
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
      channelStatusLines: ["📍 Topic: -1001234567890:topic:42"],
    });

    expect(text).toContain("🧵 Session: agent:main:telegram:group:-1001234567890:topic:42");
    expect(text).toContain("📍 Topic: -1001234567890:topic:42");
  });
});
