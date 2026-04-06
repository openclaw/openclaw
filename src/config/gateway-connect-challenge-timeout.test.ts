import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("gateway.connectChallengeTimeoutMs", () => {
  it("accepts values above the old 10-second handshake cap", () => {
    const result = validateConfigObject({
      gateway: {
        connectChallengeTimeoutMs: 20_000,
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects values above the runtime max", () => {
    const result = validateConfigObject({
      gateway: {
        connectChallengeTimeoutMs: 300_001,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain("connectChallengeTimeoutMs");
  });
});
