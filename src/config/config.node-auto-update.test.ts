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

  it.each(["false", 0, null])("rejects non-boolean enabled=%j", (enabled) => {
    const result = validateConfigObject({ nodeHost: { autoUpdate: { enabled } } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "nodeHost.autoUpdate.enabled")).toBe(
        true,
      );
    }
  });
});
