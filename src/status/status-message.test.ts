import { describe, expect, it } from "vitest";
import { formatFastModeLabel } from "./status-labels.js";
import { buildStatusMessage } from "./status-message.js";

describe("formatFastModeLabel", () => {
  it("shows fast mode when enabled", () => {
    expect(formatFastModeLabel(true)).toBe("Fast: on");
  });

  it("shows fast mode when disabled", () => {
    expect(formatFastModeLabel(false)).toBe("Fast: off");
  });
});

describe("buildStatusMessage fallback filtering", () => {
  it("excludes session-selected model from configured fallbacks", () => {
    const result = buildStatusMessage({
      agent: {
        model: {
          primary: "google/gemini-3-flash-preview",
          fallbacks: [
            "google/gemini-3.1-flash-lite",
            "google/gemini-2.5-flash",
            "google/gemini-3.1-pro-preview",
          ],
        },
      },
      sessionEntry: {
        sessionId: "test-session",
        updatedAt: Date.now(),
        modelOverride: "google/gemini-3.1-flash-lite",
      },
    });
    expect(result).toContain("🔄 Fallbacks:");
    expect(result).not.toContain("Fallbacks: google/gemini-3.1-flash-lite,");
    expect(result).toContain("google/gemini-2.5-flash");
    expect(result).toContain("google/gemini-3.1-pro-preview");
  });

  it("shows all fallbacks when none match selected model", () => {
    const result = buildStatusMessage({
      agent: {
        model: {
          primary: "google/gemini-3-flash-preview",
          fallbacks: ["google/gemini-3.1-flash-lite", "google/gemini-2.5-flash"],
        },
      },
    });
    expect(result).toContain("google/gemini-3.1-flash-lite");
    expect(result).toContain("google/gemini-2.5-flash");
  });

  it("hides fallbacks line when all fallbacks match selected model", () => {
    const result = buildStatusMessage({
      agent: {
        model: {
          primary: "google/gemini-3-flash-preview",
          fallbacks: ["google/gemini-3-flash-preview"],
        },
      },
    });
    expect(result).not.toContain("Fallbacks:");
  });
});
