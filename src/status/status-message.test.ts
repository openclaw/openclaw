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
  it("labels Runtime as the sandbox runtime", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
        contextTokens: 32_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
      now: 0,
    });

    expect(text).toContain("Runtime (sandbox):");
    expect(text).not.toContain("Runtime: ");
  });
});
