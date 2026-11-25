// Covers logging retentionDays config validation.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation-core.js";

describe("logging.retentionDays config", () => {
  it("accepts a positive retention period", () => {
    const res = validateConfigObject({ logging: { retentionDays: 30 } });
    expect(res.ok).toBe(true);
  });

  it("accepts a latest-stable persisted logging config without retentionDays", () => {
    const res = validateConfigObject({
      logging: { level: "info", file: "/tmp/openclaw-YYYY-MM-DD.log" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.logging?.retentionDays).toBeUndefined();
    }
  });

  it("rejects a non-positive retention period", () => {
    const res = validateConfigObject({ logging: { retentionDays: 0 } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toHaveLength(1);
      expect(res.issues[0]?.path).toBe("logging.retentionDays");
    }
  });
});
