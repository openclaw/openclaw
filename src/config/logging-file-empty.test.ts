// Schema-level tests for logging.file blank-value validation.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("logging.file config", () => {
  it.each(["", "   ", "\t"])("rejects blank logging.file value %j", (file) => {
    const res = validateConfigObject({ logging: { file } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toMatch(/logging\.file/);
    }
  });

  it("preserves exact bytes of a nonblank logging.file", () => {
    const file = "  /var/log/openclaw log.log  ";
    const res = validateConfigObject({ logging: { file } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.logging?.file).toBe(file);
    }
  });
});
