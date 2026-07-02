// Schema-level tests for logging.file blank-value compatibility.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("logging.file config", () => {
  it("keeps an empty logging.file validation-compatible", () => {
    // Blank persisted values must not fail schema validation: the runtime
    // trim/fallback treats them as unset, and rejecting here would break
    // startup for configs that previously stored an empty file path.
    const res = validateConfigObject({ logging: { file: "" } });
    expect(res.ok).toBe(true);
  });

  it("accepts a non-empty logging.file", () => {
    const res = validateConfigObject({ logging: { file: "/var/log/openclaw.log" } });
    expect(res.ok).toBe(true);
  });
});
