import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation-core.js";

describe("agent blank cwd config", () => {
  it("reports a field-level issue for an explicitly blank per-agent cwd", () => {
    const result = validateConfigObjectRaw({
      agents: { defaults: { cwd: "/tmp/default" }, entries: { alpha: { cwd: "   " } } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected blank per-agent cwd to fail validation");
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "agents.entries.alpha.cwd",
        message: expect.stringContaining("must not be blank"),
      }),
    );
  });

  it("reports a field-level issue for a blank defaults cwd that agents depend on", () => {
    const result = validateConfigObjectRaw({
      agents: { defaults: { cwd: " " }, entries: { alpha: {} } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected blank defaults cwd to fail validation");
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "agents.defaults.cwd",
        message: expect.stringContaining("must not be blank"),
      }),
    );
  });

  it("accepts a valid per-agent cwd even when the defaults cwd is blank", () => {
    const result = validateConfigObjectRaw({
      agents: { defaults: { cwd: " " }, entries: { alpha: { cwd: "/tmp/alpha" } } },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts configs with no cwd at all", () => {
    const result = validateConfigObjectRaw({ agents: { entries: { alpha: {} } } });

    expect(result.ok).toBe(true);
  });
});
