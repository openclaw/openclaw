import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("node automatic-update config", () => {
  it.each([undefined, true, false])("preserves enabled=%s", (enabled) => {
    const result = validateConfigObject({ nodeHost: { autoUpdate: { enabled } } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nodeHost?.autoUpdate?.enabled).toBe(enabled);
    }
  });

  it("rejects a string instead of coercing enabled to a boolean", () => {
    const result = validateConfigObject({ nodeHost: { autoUpdate: { enabled: "false" } } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "nodeHost.autoUpdate.enabled")).toBe(
        true,
      );
    }
  });
});
