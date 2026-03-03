import { describe, expect, it } from "vitest";
import { isSystemOriginRun } from "./agent-runner.js";

describe("isSystemOriginRun", () => {
  it("treats rewritten messageProvider as system-origin when session provider is system", () => {
    expect(
      isSystemOriginRun({
        messageProvider: "telegram",
        sessionProvider: "system",
      }),
    ).toBe(true);
  });

  it("treats explicit system message providers as system-origin", () => {
    expect(isSystemOriginRun({ messageProvider: "cron" })).toBe(true);
    expect(isSystemOriginRun({ messageProvider: "hook" })).toBe(true);
    expect(isSystemOriginRun({ messageProvider: "system" })).toBe(true);
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
