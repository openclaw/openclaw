import { describe, expect, it } from "vitest";
import { isSystemOriginRun } from "./agent-runner.js";

describe("isSystemOriginRun", () => {
  it("does not treat rewritten user messageProvider as system-origin via session fallback", () => {
    expect(
      isSystemOriginRun({
        messageProvider: "telegram",
        sessionProvider: "system",
      }),
    ).toBe(false);
  });

  it("treats rewritten messageProvider as system-origin when source provider is system", () => {
    expect(
      isSystemOriginRun({
        messageProvider: "telegram",
        sourceMessageProvider: "system",
        sessionProvider: "telegram",
        sessionSurface: "telegram",
      }),
    ).toBe(true);
  });

  it("treats explicit system message providers as system-origin", () => {
    expect(isSystemOriginRun({ messageProvider: "cron" })).toBe(true);
    expect(isSystemOriginRun({ messageProvider: "hook" })).toBe(true);
    expect(isSystemOriginRun({ messageProvider: "system" })).toBe(true);
  });

  it("falls back to session provider when message-level providers are missing", () => {
    expect(
      isSystemOriginRun({
        sessionProvider: "system",
      }),
    ).toBe(true);
  });

  it("does not classify normal channel providers as system-origin", () => {
    expect(
      isSystemOriginRun({
        messageProvider: "telegram",
        sessionProvider: "webchat",
        sessionSurface: "webchat",
      }),
    ).toBe(false);
  });
});
