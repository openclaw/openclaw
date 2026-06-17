// Schema-level tests for logging.file minimum-length validation.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("logging.file config", () => {
  it("rejects empty string for logging.file", () => {
    const res = validateConfigObject({ logging: { file: "" } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("logging.file");
    }
  });

  it("accepts a non-empty logging.file", () => {
    const res = validateConfigObject({ logging: { file: "/var/log/openclaw.log" } });
    expect(res.ok).toBe(true);
  });
});
